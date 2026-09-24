import { describe, expect, it } from 'vitest';
import { signMfaTicket, verifyMfaTicket } from '../../../src/auth/cookies.js';

describe('MFA ticket', () => {
  const ticket = { userId: '0b9c7c9e-1111-4222-8333-444455556666', nonce: 'abc', expiresAt: 2_000 };

  it('round-trips while unexpired', () => {
    expect(verifyMfaTicket('k', signMfaTicket('k', ticket), 1_000)).toEqual(ticket);
  });

  it('refuses an expired, forged, re-keyed or malformed ticket', () => {
    const signed = signMfaTicket('k', ticket);
    expect(verifyMfaTicket('k', signed, 2_000)).toBeNull();
    expect(verifyMfaTicket('other', signed, 1_000)).toBeNull();
    const forged = signed.replace(ticket.userId, '0b9c7c9e-9999-4222-8333-444455556666');
    expect(verifyMfaTicket('k', forged, 1_000)).toBeNull();
    const extended = signed.replace('.2000.', '.9999999.');
    expect(verifyMfaTicket('k', extended, 1_000)).toBeNull();
    expect(verifyMfaTicket('k', 'garbage', 1_000)).toBeNull();
  });
});
