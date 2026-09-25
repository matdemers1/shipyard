import { createHash } from 'node:crypto';

/**
 * The agent protocol's signing format (SHP-D-064), shared so the agent and the server can never
 * disagree on the bytes. The agent signs `signingString(...)` with its Ed25519 key; the server
 * rebuilds the same string from the request it received and verifies it.
 */
export const SIGNING_VERSION = 'shipyard-v1';

/** Maximum clock skew the server accepts between the agent's timestamp and its own (SHP-REQ-103). */
export const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

/** Lowercase hex SHA-256 of the exact request body bytes (empty body → hash of zero bytes). */
export function bodyDigest(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

export interface SigningInput {
  method: string;
  /** The request path including any query string, as sent (e.g. `/api/agent/poll`). */
  path: string;
  /** Unix epoch milliseconds, as a decimal string. */
  timestamp: string;
  nonce: string;
  body: Uint8Array;
}

export function signingString(input: SigningInput): string {
  return [SIGNING_VERSION, input.method.toUpperCase(), input.path, input.timestamp, input.nonce, bodyDigest(input.body)].join('\n');
}

/** `SHA256:<base64 of sha256(raw public key)>`, like an SSH fingerprint: what the console shows. */
export function fingerprintOf(rawPublicKey: Uint8Array): string {
  return `SHA256:${createHash('sha256').update(rawPublicKey).digest('base64').replace(/=+$/, '')}`;
}
