import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { generateTotpSecret, hashPassword, totpUri } from '../auth/index.js';
import { loadConfig } from '../config.js';
import { createDb, type Db } from '../db.js';
import { createLogger } from '../logger.js';

/**
 * Creates the first (and only) account (SHP-REQ-002); there is no signup route (SHP-REQ-101).
 * Run as `pnpm --filter shipyard-server bootstrap-admin -- --email you@example.com --name "Your Name"`
 * or, compiled, `node dist/cli/bootstrap-admin.js --email ... --name ...`.
 */

const MIN_PASSWORD_LENGTH = 12;

/**
 * A fixed key for `pg_advisory_xact_lock`, held for the life of the bootstrap transaction so two
 * concurrent runs cannot both observe an empty `user` table and both insert. First-run setup in
 * the console (src/setup) takes the same lock, so the CLI and the browser serialise with each other.
 */
export const BOOTSTRAP_LOCK_KEY = 847_291_003_771n;

/** Thrown when an account already exists; bootstrap-admin only ever creates the first one. */
export class AlreadyBootstrapped extends Error {
  constructor() {
    super('an account already exists; bootstrap-admin only creates the first one');
    this.name = 'AlreadyBootstrapped';
  }
}

export interface BootstrapAdminInput {
  email: string;
  name: string;
  password: string;
  now?: Date;
}

export interface BootstrapAdminResult {
  userId: string;
  totpUri: string;
  secret: string;
}

/**
 * Creates the first admin, inside a transaction guarded by an advisory lock: a concurrent second
 * call blocks until the first commits, then finds a non-empty `user` table and refuses.
 */
export async function bootstrapAdmin(db: Db, input: BootstrapAdminInput): Promise<BootstrapAdminResult> {
  const email = input.email.trim().toLowerCase();
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const now = input.now ?? new Date();
  const passwordHash = await hashPassword(input.password);
  const secret = generateTotpSecret();

  const user = await db.$transaction(async (tx) => {
    await tx.$executeRaw`select pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`;
    const existing = await tx.user.count();
    if (existing > 0) throw new AlreadyBootstrapped();

    const created = await tx.user.create({
      data: {
        email,
        displayName: input.name,
        passwordHash,
        totpSecret: secret,
        totpEnabledAt: now,
        role: 'admin',
      },
    });
    await tx.auditEvent.create({
      data: {
        actorType: 'system',
        actorLabel: 'bootstrap-admin',
        action: 'user.bootstrap',
        entityType: 'user',
        entityId: created.id,
        after: { email: created.email, role: created.role },
      },
    });
    return created;
  });

  return { userId: user.id, totpUri: totpUri(secret, email), secret };
}

interface CliArgs {
  email: string;
  name: string;
}

/** Only `--email` and `--name` are accepted. `--password` (or anything else) is refused. */
function parseArgs(argv: string[]): CliArgs {
  let email: string | undefined;
  let name: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--email') {
      i += 1;
      email = argv[i];
    } else if (arg === '--name') {
      i += 1;
      name = argv[i];
    } else if (arg === '--password') {
      throw new Error(
        'the password may not be passed as an argument (it would land in shell history and ps); ' +
          'set BOOTSTRAP_PASSWORD or answer the interactive prompt',
      );
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (email === undefined || name === undefined) {
    throw new Error('usage: bootstrap-admin --email <email> --name <display name>');
  }
  return { email, name };
}

/** Reads a line from stdin without echoing it. */
function promptPassword(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true }) as Interface & {
      _writeToOutput?: (data: string) => void;
    };
    process.stdout.write(promptText);
    rl._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function resolvePassword(): Promise<string> {
  const fromEnv = process.env['BOOTSTRAP_PASSWORD'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  if (!process.stdin.isTTY) {
    throw new Error(
      'BOOTSTRAP_PASSWORD is not set and stdin is not a terminal; set the env var or run this interactively',
    );
  }
  return promptPassword(`Password (at least ${MIN_PASSWORD_LENGTH} characters): `);
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const db = createDb(config.DATABASE_URL);
  try {
    const { email, name } = parseArgs(process.argv.slice(2));
    const password = await resolvePassword();
    const result = await bootstrapAdmin(db, { email, name, password });
    process.stdout.write(`Admin account created: ${email}\n`);
    process.stdout.write(`TOTP secret (base32, enrol it now — this is the only time it is shown): ${result.secret}\n`);
    process.stdout.write(`otpauth URI: ${result.totpUri}\n`);
    process.exitCode = 0;
  } catch (error) {
    if (error instanceof AlreadyBootstrapped) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: message }, 'bootstrap-admin failed');
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return fileURLToPath(import.meta.url) === entry;
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
