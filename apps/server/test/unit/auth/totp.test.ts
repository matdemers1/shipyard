import { describe, expect, it } from 'vitest';
import { TotpReplayGuard, generateTotpSecret, matchTotpStep, totpCode, totpUri, verifyTotp } from '../../../src/auth/totp.js';

const T = 1_800_000_000_000;

describe('totp', () => {
  it('generates a base32 secret and an otpauth URI naming Shipyard and the email', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const uri = totpUri(secret, 'ops@example.com');
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('issuer=Shipyard');
    expect(uri).toContain('ops%40example.com');
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });

  it('accepts the current code and one step either side, nothing further', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, totpCode(secret, T), T)).toBe(true);
    expect(verifyTotp(secret, totpCode(secret, T - 30_000), T)).toBe(true);
    expect(verifyTotp(secret, totpCode(secret, T + 30_000), T)).toBe(true);
    expect(matchTotpStep(secret, totpCode(secret, T - 90_000), T)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', T)).toBe(false);
  });

  it('refuses the same code twice, and an older code after a newer one', () => {
    const secret = generateTotpSecret();
    const guard = new TotpReplayGuard();
    const now = totpCode(secret, T);
    const earlier = totpCode(secret, T - 30_000);
    expect(guard.consume('u1', secret, now, T)).toBe(true);
    expect(guard.consume('u1', secret, now, T)).toBe(false);
    expect(guard.consume('u1', secret, earlier, T)).toBe(false);
    // Per user.
    expect(guard.consume('u2', secret, now, T)).toBe(true);
    // The next step is fine.
    expect(guard.consume('u1', secret, totpCode(secret, T + 30_000), T + 30_000)).toBe(true);
  });
});
