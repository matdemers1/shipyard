import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../../src/auth/passwords.js';

describe('passwords', () => {
  it('hashes with argon2id and verifies', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });

  it('returns false for a malformed hash rather than throwing', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });
});
