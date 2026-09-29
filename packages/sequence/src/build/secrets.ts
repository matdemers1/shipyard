import { createCipheriv, createDecipheriv, createPrivateKey, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';
import { chmod, chown, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The agent's encrypted build-secret store (SHP-T-7.9, SHP-REQ-125).
 *
 * Build secrets (a private registry token a Dockerfile `RUN --mount=type=secret` needs) live only
 * on the agent's host, at `<dataRoot>/agent/build-secrets.json` (mode 0600), and never on the
 * server. Each value is sealed with AES-256-GCM under a key derived with HKDF-SHA256 from the
 * agent's own Ed25519 private key (`<dataRoot>/agent/agent.key`): the file on its own — a backup,
 * a copied volume — opens nothing. The salt is random per install and kept in the file's header;
 * every entry has its own random 12-byte IV and is bound to its `<app>/<name>` as additional
 * authenticated data, so an entry moved to another name fails to open rather than leaking into the
 * wrong build.
 *
 * Names are in the clear (the CLI lists them); values never are. A wrong key, a tampered entry or
 * a malformed file throws `BuildSecretsError` — never a garbage value.
 *
 * Written by the host CLI (`shipyard-run build-secret set …`, the value from stdin only) and read
 * by the agent's build worker.
 */

export const BUILD_SECRETS_FILE_VERSION = 1;
const HKDF_INFO = 'shipyard build secrets v1';
const APP_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export class BuildSecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildSecretsError';
  }
}

interface SealedEntry {
  iv: string;
  ct: string;
  tag: string;
}

interface SecretsFile {
  v: 1;
  /** Base64, 16 random bytes, fixed for the life of the file. */
  salt: string;
  entries: Record<string, SealedEntry>;
}

/** `<dataRoot>/agent/agent.key` — the same path the agent's identity uses (apps/agent/src/identity.ts). */
export function agentKeyPath(dataRoot: string): string {
  return join(dataRoot, 'agent', 'agent.key');
}

export function buildSecretsPath(dataRoot: string): string {
  return join(dataRoot, 'agent', 'build-secrets.json');
}

function checkApp(app: string): void {
  if (!APP_RE.test(app)) throw new BuildSecretsError(`invalid app name ${JSON.stringify(app)}: lowercase alphanumeric and hyphens, max 63 chars`);
}

function checkName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new BuildSecretsError(`invalid build secret name ${JSON.stringify(name)}: lowercase alphanumeric and _.-, starting alphanumeric, max 63 chars`);
  }
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Reads the agent's Ed25519 private key. Refuses a key file readable by group or others, and a key
 * of any other type. The CLI uses this; the agent loads the same file.
 */
export async function loadAgentPrivateKey(dataRoot: string): Promise<KeyObject> {
  const path = agentKeyPath(dataRoot);
  let mode: number;
  try {
    mode = (await stat(path)).mode;
  } catch (err) {
    if (isNotFound(err)) throw new BuildSecretsError(`no agent key at ${path}: start the agent once so it creates its key, then retry`);
    throw err;
  }
  if ((mode & 0o077) !== 0) throw new BuildSecretsError(`agent key ${path} is readable by group or others; run chmod 600 ${path}`);
  const key = createPrivateKey(await readFile(path, 'utf8'));
  if (key.asymmetricKeyType !== 'ed25519') throw new BuildSecretsError(`agent key ${path} is not an Ed25519 key`);
  return key;
}

/** The 32-byte Ed25519 seed: the input keying material. */
function seedOf(privateKey: KeyObject): Buffer {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    throw new BuildSecretsError('the build-secret key must be the agent’s Ed25519 private key');
  }
  const jwk = privateKey.export({ format: 'jwk' });
  if (typeof jwk.d !== 'string') throw new BuildSecretsError('could not read the agent key');
  return Buffer.from(jwk.d, 'base64url');
}

function deriveKey(privateKey: KeyObject, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', seedOf(privateKey), salt, HKDF_INFO, 32));
}

function aad(entryKey: string): Buffer {
  return Buffer.from(`shipyard-build-secret:v1:${entryKey}`, 'utf8');
}

function b64(value: unknown, what: string, bytes?: number): Buffer {
  if (typeof value !== 'string' || !B64_RE.test(value)) throw new BuildSecretsError(`build secrets file is malformed (${what})`);
  const buf = Buffer.from(value, 'base64');
  if (bytes !== undefined && buf.length !== bytes) throw new BuildSecretsError(`build secrets file is malformed (${what})`);
  return buf;
}

async function readFileOrNull(dataRoot: string): Promise<SecretsFile | null> {
  let text: string;
  try {
    text = await readFile(buildSecretsPath(dataRoot), 'utf8');
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new BuildSecretsError('build secrets file is not valid JSON; it has been altered');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new BuildSecretsError('build secrets file is malformed');
  const file = parsed as Record<string, unknown>;
  if (file['v'] !== BUILD_SECRETS_FILE_VERSION) throw new BuildSecretsError(`build secrets file has unknown version ${String(file['v'])}`);
  b64(file['salt'], 'salt', 16);
  const entries = file['entries'];
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
    throw new BuildSecretsError('build secrets file is malformed (entries)');
  }
  return file as unknown as SecretsFile;
}

function seal(key: Buffer, entryKey: string, value: string): SealedEntry {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(entryKey));
  const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

function unseal(key: Buffer, entryKey: string, entry: unknown): string {
  if (typeof entry !== 'object' || entry === null) throw new BuildSecretsError(`build secret ${entryKey} is malformed`);
  const e = entry as Partial<SealedEntry>;
  const iv = b64(e.iv, `${entryKey} iv`, 12);
  const ct = b64(e.ct, `${entryKey} ct`);
  const tag = b64(e.tag, `${entryKey} tag`, 16);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad(entryKey));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new BuildSecretsError(
      `build secret ${entryKey} cannot be decrypted with this agent's key: the file was altered, or the key is not the one that sealed it. Set the secret again with shipyard-run build-secret set.`,
    );
  }
}

/** Writes the file atomically (temp 0600 → fsync → rename), owned like the agent key when run as root. */
async function writeSecretsFile(dataRoot: string, file: SecretsFile): Promise<void> {
  const dir = join(dataRoot, 'agent');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = buildSecretsPath(dataRoot);
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(tmp, 0o600);
    // The host CLI often runs as root while the agent runs as its own uid: hand the file to
    // whoever owns the agent's key, so the agent can read it and nobody else can.
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      try {
        const owner = await stat(agentKeyPath(dataRoot));
        await chown(tmp, owner.uid, owner.gid);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    }
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** Seals `value` as build secret `name` of `app`, replacing any earlier value. */
export async function setBuildSecret(dataRoot: string, privateKey: KeyObject, app: string, name: string, value: string): Promise<void> {
  checkApp(app);
  checkName(name);
  if (value.length === 0) throw new BuildSecretsError('a build secret value cannot be empty');
  const existing = await readFileOrNull(dataRoot);
  const file: SecretsFile = existing ?? { v: 1, salt: randomBytes(16).toString('base64'), entries: {} };
  const key = deriveKey(privateKey, Buffer.from(file.salt, 'base64'));
  // Prove this key opens what is already there before adding to it: one file, one key.
  for (const [entryKey, entry] of Object.entries(file.entries)) unseal(key, entryKey, entry);
  const entryKey = `${app}/${name}`;
  file.entries[entryKey] = seal(key, entryKey, value);
  await writeSecretsFile(dataRoot, file);
}

/** Removes build secret `name` of `app`. Resolves false when it was not set. */
export async function deleteBuildSecret(dataRoot: string, privateKey: KeyObject, app: string, name: string): Promise<boolean> {
  checkApp(app);
  checkName(name);
  const file = await readFileOrNull(dataRoot);
  const entryKey = `${app}/${name}`;
  if (file === null || !(entryKey in file.entries)) return false;
  // Only the holder of the key may change the file.
  const key = deriveKey(privateKey, Buffer.from(file.salt, 'base64'));
  unseal(key, entryKey, file.entries[entryKey]);
  file.entries = Object.fromEntries(Object.entries(file.entries).filter(([k]) => k !== entryKey));
  await writeSecretsFile(dataRoot, file);
  return true;
}

/** The names of `app`'s build secrets, sorted. Reads no value. */
export async function listBuildSecretNames(dataRoot: string, app: string): Promise<string[]> {
  checkApp(app);
  const file = await readFileOrNull(dataRoot);
  if (file === null) return [];
  const prefix = `${app}/`;
  return Object.keys(file.entries)
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length))
    .sort();
}

/** Every build secret of `app`, decrypted, by name. Throws on a wrong key or a tampered entry. */
export async function readBuildSecrets(dataRoot: string, privateKey: KeyObject, app: string): Promise<Map<string, string>> {
  checkApp(app);
  const out = new Map<string, string>();
  const file = await readFileOrNull(dataRoot);
  if (file === null) return out;
  const key = deriveKey(privateKey, Buffer.from(file.salt, 'base64'));
  const prefix = `${app}/`;
  for (const [entryKey, entry] of Object.entries(file.entries)) {
    if (!entryKey.startsWith(prefix)) continue;
    const name = entryKey.slice(prefix.length);
    if (!NAME_RE.test(name)) throw new BuildSecretsError(`build secrets file names an invalid secret ${JSON.stringify(entryKey)}`);
    out.set(name, unseal(key, entryKey, entry));
  }
  return out;
}
