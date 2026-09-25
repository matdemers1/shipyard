import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { assertCanActOn, assertCanChangeState, type Role } from '../../src/auth/scope.js';
import { PREFIX_LENGTH, TOKEN_RE, generateToken, hashToken } from '../../src/tokens/tokens.js';

function fakeReq(init: {
  actor?: { type: 'user' | 'token' | 'agent' | 'system'; id?: string; label: string };
  role?: Role;
  tokenApps?: string[];
}): Request {
  return {
    ...(init.actor !== undefined ? { actor: init.actor } : {}),
    ...(init.role !== undefined ? { role: init.role } : {}),
    ...(init.tokenApps !== undefined ? { tokenApps: new Set(init.tokenApps) } : {}),
  } as unknown as Request;
}

describe('generateToken', () => {
  it('is shp_ plus 32 random bytes of base64url, with a 12-character prefix and a sha256 hash', () => {
    const { token, hash, prefix } = generateToken();
    expect(token).toMatch(TOKEN_RE);
    expect(Buffer.from(token.slice(4), 'base64url')).toHaveLength(32);
    expect(prefix).toBe(token.slice(0, PREFIX_LENGTH));
    expect(prefix).toHaveLength(12);
    expect(hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(hash).not.toContain(token);
    expect(hashToken(token)).toBe(hash);
  });

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateToken().token));
    expect(seen.size).toBe(200);
  });
});

describe('assertCanActOn', () => {
  const token = { type: 'token' as const, id: 't1', label: 'token ci' };
  const user = { type: 'user' as const, id: 'u1', label: 'a@example.com' };

  it('refuses a request with no actor as unauthenticated', () => {
    expect(assertCanActOn(fakeReq({}), 'web')?.code).toBe('unauthenticated');
  });

  it('lets a token act on an app in its scope, and refuses any other app', () => {
    const req = fakeReq({ actor: token, role: 'deployer', tokenApps: ['web', 'api'] });
    expect(assertCanActOn(req, 'web')).toBeNull();
    const refused = assertCanActOn(req, 'billing');
    expect(refused?.code).toBe('forbidden');
    expect(refused?.message).toContain('not scoped to billing');
  });

  it('refuses a token whose owner is a viewer, even in scope', () => {
    const req = fakeReq({ actor: token, role: 'viewer', tokenApps: ['web'] });
    expect(assertCanActOn(req, 'web')?.code).toBe('forbidden');
  });

  it.each<Role>(['admin', 'operator', 'deployer'])('lets a %s user act on any app', (role) => {
    expect(assertCanActOn(fakeReq({ actor: user, role }), 'web')).toBeNull();
  });

  it('refuses a viewer', () => {
    expect(assertCanActOn(fakeReq({ actor: user, role: 'viewer' }), 'web')?.code).toBe('forbidden');
  });

  it('refuses a user whose role is unknown', () => {
    expect(assertCanActOn(fakeReq({ actor: user }), 'web')?.code).toBe('forbidden');
  });

  it('refuses an agent actor', () => {
    expect(assertCanActOn(fakeReq({ actor: { type: 'agent', id: 'a', label: 'agent' } }), 'web')?.code).toBe(
      'forbidden',
    );
  });
});

describe('assertCanChangeState', () => {
  it('refuses a viewer and allows a deployer', () => {
    const user = { type: 'user' as const, id: 'u1', label: 'a@example.com' };
    expect(assertCanChangeState(fakeReq({ actor: user, role: 'viewer' }))?.code).toBe('forbidden');
    expect(assertCanChangeState(fakeReq({ actor: user, role: 'deployer' }))).toBeNull();
    expect(assertCanChangeState(fakeReq({}))?.code).toBe('unauthenticated');
  });
});
