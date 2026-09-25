import { fileURLToPath } from 'node:url';
import { AppName } from '@shipyard/schema';
import { loadConfig } from '../config.js';
import { createDb, type Db } from '../db.js';
import { createLogger } from '../logger.js';
import { generateToken } from '../tokens/tokens.js';

/**
 * Host-only administration, for the moments before the console exists or when it is out of reach:
 * confirming the agent's fingerprint and issuing an API token for a Claude Code session. Anyone who
 * can run this can already reach the database, so it adds no power; it is the host act that
 * onboarding already is (SHP-D-059, SHP-D-079). Every action is audited as `host-admin`.
 *
 *   node dist/cli/host-admin.js confirm-agent --fingerprint SHA256:…
 *   node dist/cli/host-admin.js issue-token --email you@example.com --label "claude: foreman" --apps foreman,foreman-board
 */

const ACTOR = { actorType: 'system' as const, actorLabel: 'host-admin' };

export class HostAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostAdminError';
  }
}

/** Confirms the agent whose fingerprint was read on the host (SHP-REQ-035). */
export async function confirmAgent(db: Db, fingerprint: string, now = new Date()): Promise<{ id: string }> {
  const agent = await db.agent.findUnique({ where: { fingerprint: fingerprint.trim() } });
  if (agent === null) throw new HostAdminError(`no agent has enrolled with fingerprint ${fingerprint}`);
  if (agent.confirmedAt !== null) return { id: agent.id };
  await db.$transaction([
    db.agent.update({ where: { id: agent.id }, data: { confirmedAt: now } }),
    db.auditEvent.create({
      data: { ...ACTOR, action: 'agent.confirmed', entityType: 'agent', entityId: agent.id, after: { fingerprint: agent.fingerprint, via: 'host-admin' } },
    }),
  ]);
  return { id: agent.id };
}

export interface IssueTokenInput {
  email: string;
  label: string;
  apps: string[];
}

/** Issues an API token owned by an existing user, scoped to reported apps (SHP-REQ-046). */
export async function issueToken(db: Db, input: IssueTokenInput): Promise<{ id: string; token: string; prefix: string }> {
  const user = await db.user.findUnique({ where: { email: input.email.trim().toLowerCase() } });
  if (user === null) throw new HostAdminError(`no user with email ${input.email}; run bootstrap-admin first`);
  if (user.disabledAt !== null) throw new HostAdminError(`${input.email} is disabled`);
  if (input.label.trim() === '' || input.label.length > 100) throw new HostAdminError('label must be 1–100 characters');
  if (input.apps.length === 0) throw new HostAdminError('at least one --apps name is required');
  const apps = await db.app.findMany({ where: { name: { in: input.apps } }, select: { id: true, name: true } });
  const missing = input.apps.filter((name) => !apps.some((a) => a.name === name));
  if (missing.length > 0) throw new HostAdminError(`not reported by the agent yet: ${missing.join(', ')}`);

  const { token, hash, prefix } = generateToken();
  const row = await db.$transaction(async (tx) => {
    const created = await tx.apiToken.create({
      data: { userId: user.id, label: input.label.trim(), tokenHash: hash, prefix, apps: { create: apps.map((a) => ({ appId: a.id })) } },
    });
    await tx.auditEvent.create({
      data: {
        ...ACTOR,
        action: 'token.created',
        entityType: 'api_token',
        entityId: created.id,
        after: { label: created.label, prefix, apps: apps.map((a) => a.name), owner: user.email, via: 'host-admin' },
      },
    });
    return created;
  });
  return { id: row.id, token, prefix };
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const db = createDb(config.DATABASE_URL);
  try {
    if (command === 'confirm-agent') {
      const fingerprint = arg(rest, 'fingerprint');
      if (fingerprint === undefined) throw new HostAdminError('usage: confirm-agent --fingerprint SHA256:…');
      const { id } = await confirmAgent(db, fingerprint);
      process.stdout.write(`confirmed agent ${id}\n`);
      return 0;
    }
    if (command === 'issue-token') {
      const email = arg(rest, 'email');
      const label = arg(rest, 'label');
      const apps = (arg(rest, 'apps') ?? '').split(',').map((a) => a.trim()).filter((a) => a !== '');
      if (email === undefined || label === undefined) throw new HostAdminError('usage: issue-token --email … --label … --apps a,b');
      for (const app of apps) {
        if (!AppName.safeParse(app).success) throw new HostAdminError(`not an app name: ${app}`);
      }
      const issued = await issueToken(db, { email, label, apps });
      // Shown once, on stdout only; never logged.
      process.stdout.write(`token (shown once): ${issued.token}\nprefix: ${issued.prefix}\n`);
      return 0;
    }
    throw new HostAdminError('commands: confirm-agent, issue-token');
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'host-admin failed');
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
