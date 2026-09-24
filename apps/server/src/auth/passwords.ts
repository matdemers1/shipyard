import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';

/** Argon2id, the library's defaults (64 MiB, t=3, p=4) — the OWASP-recommended family. */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

/** False for a wrong password *and* for a malformed hash; never throws on bad input. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Burns the same time as a real verification, for an email that has no account (or no password),
 * so response timing does not say which emails exist.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64url'));
  await verifyPassword(await dummyHash, password);
  return false;
}
