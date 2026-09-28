import { describe, expect, it } from 'vitest';

import { ACTIVE_STATES, PollRequest, PollResponse } from '../src/agent.js';

describe('ACTIVE_STATES', () => {
  it('has exactly the nine states between locked and rolling_back', () => {
    expect(ACTIVE_STATES).toEqual([
      'locked',
      'verifying',
      'backing_up',
      'migrating',
      'pulling',
      'swapping',
      'checking',
      'soaking',
      'rolling_back',
    ]);
    expect(ACTIVE_STATES).toHaveLength(9);
  });
});

describe('PollRequest.capabilities (SHP-T-7.2)', () => {
  it('accepts a request with no capabilities, same as an older agent', () => {
    expect(PollRequest.safeParse({ waitSeconds: 10 }).success).toBe(true);
  });

  it("accepts a request naming 'build'", () => {
    expect(PollRequest.safeParse({ waitSeconds: 10, capabilities: ['build'] }).success).toBe(true);
  });

  it('rejects an unknown capability', () => {
    expect(PollRequest.safeParse({ waitSeconds: 10, capabilities: ['deploy'] }).success).toBe(false);
  });
});

describe('PollResponse build variant (SHP-T-7.2)', () => {
  it('accepts { target: null } (no work), unchanged', () => {
    expect(PollResponse.safeParse({ target: null }).success).toBe(true);
  });

  it('accepts { target: PollTarget } (a deploy target), unchanged', () => {
    const result = PollResponse.safeParse({
      target: {
        targetId: 'tgt_1', deployId: 'dep_1', kind: 'deploy', app: 'bindery',
        sha: '0123456789abcdef0123456789abcdef01234567', dryRun: false,
      },
    });
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues)).toBe(true);
  });

  it('accepts { target: null, build: BuildJob }, the new third variant', () => {
    const result = PollResponse.safeParse({
      target: null,
      build: { buildId: 'bld_1', app: 'bindery', sha: '0123456789abcdef0123456789abcdef01234567' },
    });
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues)).toBe(true);
  });

  it('rejects a target and a build together', () => {
    const result = PollResponse.safeParse({
      target: {
        targetId: 'tgt_1', deployId: 'dep_1', kind: 'deploy', app: 'bindery',
        sha: '0123456789abcdef0123456789abcdef01234567', dryRun: false,
      },
      build: { buildId: 'bld_1', app: 'bindery', sha: '0123456789abcdef0123456789abcdef01234567' },
    });
    expect(result.success).toBe(false);
  });
});
