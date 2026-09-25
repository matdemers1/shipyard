import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { chmod, mkdir, open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fingerprintOf, signingString, type SignatureHeaders } from '@shipyard/schema';

/**
 * The agent's Ed25519 identity (SHP-REQ-034). The private key lives at
 * `<dataRoot>/agent/agent.key` as PKCS8 PEM, mode 0600; the server knows the agent only by the
 * public key's fingerprint, which an owner confirms in the console.
 */
export interface AgentIdentity {
  /** The raw 32-byte Ed25519 public key. */
  publicKeyRaw: Buffer;
  /** `publicKeyRaw` as base64: what `EnrolRequest.publicKey` carries. */
  publicKeyB64: string;
  /** `SHA256:<b64>`: what the console shows and `x-shipyard-key` carries. */
  fingerprint: string;
  sign(data: string): Buffer;
}

export class InsecureKeyFileError extends Error {
  readonly fix: string;
  constructor(path: string, mode: number) {
    const octal = (mode & 0o777).toString(8).padStart(3, '0');
    super(`agent key ${path} is readable by group or others (mode ${octal}); refusing to start`);
    this.name = 'InsecureKeyFileError';
    this.fix = `chmod 600 ${path}`;
  }
}

export function keyPath(dataRoot: string): string {
  return join(dataRoot, 'agent', 'agent.key');
}

function identityFrom(privateKey: KeyObject): AgentIdentity {
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  // Ed25519 SPKI DER is a fixed 12-byte prefix followed by the raw 32-byte key.
  const publicKeyRaw = Buffer.from(spki.subarray(spki.length - 32));
  return {
    publicKeyRaw,
    publicKeyB64: publicKeyRaw.toString('base64'),
    fingerprint: fingerprintOf(publicKeyRaw),
    sign: (data: string) => sign(null, Buffer.from(data, 'utf8'), privateKey),
  };
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Loads the agent's key, or creates it (0600) on first start. A group/world-readable key is refused. */
export async function loadOrCreateIdentity(dataRoot: string): Promise<AgentIdentity> {
  const path = keyPath(dataRoot);
  let mode: number | undefined;
  try {
    mode = (await stat(path)).mode;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  if (mode !== undefined) {
    if ((mode & 0o077) !== 0) throw new InsecureKeyFileError(path, mode);
    const pem = await readFile(path, 'utf8');
    const privateKey = createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error(`agent key ${path} is not an Ed25519 key`);
    }
    return identityFrom(privateKey);
  }

  await mkdir(join(dataRoot, 'agent'), { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  // `wx`: never overwrite a key another process wrote first.
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(pem, 'utf8');
  } finally {
    await handle.close();
  }
  // The umask can only remove bits; set the mode explicitly anyway.
  await chmod(path, 0o600);
  return identityFrom(privateKey);
}

export interface SignInput {
  method: string;
  /** The path and query exactly as sent, e.g. `/api/agent/poll`. */
  path: string;
  /** The exact body bytes sent (empty for none). */
  body: Uint8Array;
  now?: number;
  nonce?: string;
}

/** The four signature headers for one request (SHP-D-064). */
export function signHeaders(identity: AgentIdentity, input: SignInput): SignatureHeaders {
  const timestamp = String(input.now ?? Date.now());
  const nonce = input.nonce ?? randomBytes(16).toString('base64url');
  const data = signingString({ method: input.method, path: input.path, timestamp, nonce, body: input.body });
  return {
    'x-shipyard-key': identity.fingerprint,
    'x-shipyard-timestamp': timestamp,
    'x-shipyard-nonce': nonce,
    'x-shipyard-signature': identity.sign(data).toString('base64'),
  };
}
