import { describe, expect, it } from 'vitest';

import { BuildConfig, BuildName, BuildResult } from '../src/build.js';

describe('BuildName', () => {
  it('accepts a lowercase target name', () => {
    expect(BuildName.safeParse('release-server').success).toBe(true);
  });

  it('rejects uppercase and spaces', () => {
    expect(BuildName.safeParse('Release').success).toBe(false);
    expect(BuildName.safeParse('release server').success).toBe(false);
  });
});

describe('BuildConfig (SHP-REQ-117)', () => {
  it('defaults source to github when omitted', () => {
    const parsed = BuildConfig.parse({});
    expect(parsed.source).toBe('github');
  });

  it('rejects any other field when source is github', () => {
    expect(BuildConfig.safeParse({ source: 'github', dockerfile: 'Dockerfile' }).success).toBe(false);
    expect(BuildConfig.safeParse({ source: 'github', testTarget: 'test' }).success).toBe(false);
    expect(BuildConfig.safeParse({ source: 'github', secrets: ['x'] }).success).toBe(false);
  });

  it('rejects an unknown key', () => {
    expect(BuildConfig.safeParse({ source: 'shipyard', script: 'echo hi' }).success).toBe(false);
  });

  it('rejects integration.argv given as a shell string', () => {
    const result = BuildConfig.safeParse({
      source: 'shipyard',
      integration: { compose: 'docker-compose.integration.yml', service: 'integration', argv: 'pnpm test' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an absolute or ../ dockerfile path', () => {
    expect(BuildConfig.safeParse({ source: 'shipyard', dockerfile: '/etc/passwd' }).success).toBe(false);
    expect(BuildConfig.safeParse({ source: 'shipyard', dockerfile: '../Dockerfile' }).success).toBe(false);
  });

  it('accepts every field populated under source shipyard', () => {
    const result = BuildConfig.safeParse({
      source: 'shipyard',
      dockerfile: 'docker/Dockerfile',
      testTarget: 'test',
      releaseTargets: { server: 'release-server' },
      integration: { compose: 'compose.integration.yml', service: 'integration', argv: ['pnpm', 'test:integration'] },
      secrets: ['npm_token'],
    });
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues)).toBe(true);
  });
});

describe('BuildResult (SHP-T-7.2)', () => {
  it('requires at least one digest when succeeded', () => {
    expect(BuildResult.safeParse({ buildId: 'bld_1', state: 'succeeded', digests: {} }).success).toBe(false);
    expect(
      BuildResult.safeParse({ buildId: 'bld_1', state: 'succeeded', digests: { server: 'sha256:' + 'a'.repeat(64) } })
        .success,
    ).toBe(true);
  });

  it('requires a refusal when refused', () => {
    expect(BuildResult.safeParse({ buildId: 'bld_1', state: 'refused', digests: {} }).success).toBe(false);
    expect(
      BuildResult.safeParse({
        buildId: 'bld_1',
        state: 'refused',
        digests: {},
        refusal: { code: 'ci_not_green', gate: 'G5', message: 'not green', fix: 'wait' },
      }).success,
    ).toBe(true);
  });

  it('allows failed/cancelled with no digests and no refusal', () => {
    expect(BuildResult.safeParse({ buildId: 'bld_1', state: 'failed', digests: {} }).success).toBe(true);
    expect(BuildResult.safeParse({ buildId: 'bld_1', state: 'cancelled', digests: {} }).success).toBe(true);
  });
});
