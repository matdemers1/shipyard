import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Encryption at rest for a secret an admin stores in Settings (SHP-REQ-110): AES-256-GCM with a key
 * derived from SESSION_SECRET by HKDF-SHA256. The stored form is `v1:` + base64(iv ‖ tag ‖ ciphertext)
 * — a random 12-byte IV per value, the 16-byte GCM tag, then the ciphertext. The version prefix lets
 * a later scheme be told apart without guessing.
 *
 * Without SESSION_SECRET the server's secret is random per process, so a value encrypted now could
 * never be read after a restart: callers must refuse to store one then (see `canStoreSecrets`).
 */

const VERSION = 'v1';
const HKDF_INFO = 'shipyard/settings/v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SettingsCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsCryptoError';
  }
}

/** The 32-byte key for settings secrets. */
export function deriveSettingsKey(sessionSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', sessionSecret, Buffer.alloc(0), HKDF_INFO, 32));
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${Buffer.concat([iv, tag, ciphertext]).toString('base64')}`;
}

/** Throws {@link SettingsCryptoError} for a malformed value, or one sealed under another key. */
export function decryptSecret(sealed: string, key: Buffer): string {
  const prefix = `${VERSION}:`;
  if (!sealed.startsWith(prefix)) throw new SettingsCryptoError('The stored secret has an unknown format.');
  const raw = Buffer.from(sealed.slice(prefix.length), 'base64');
  if (raw.length < IV_BYTES + TAG_BYTES) throw new SettingsCryptoError('The stored secret is truncated.');
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new SettingsCryptoError('The stored secret cannot be decrypted: SESSION_SECRET has changed since it was saved.');
  }
}
