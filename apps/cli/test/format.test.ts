import { describe, expect, it } from 'vitest';
import type { DeployResult, RecoveryResult, RunningContainer } from '@shipyard/sequence';

import { deployExitCode, formatDeployResult, formatProgress, formatRecovery, formatStatus } from '../src/format.js';

const SHA = 'a'.repeat(40);

function result(overrides: Partial<DeployResult>): DeployResult {
  return {
    deployId: 'dep-1',
    app: 'toy',
    state: 'succeeded',
    sha: SHA,
    images: [],
    schemaRevision: null,
    gates: [],
    refusal: null,
    steps: [],
    backupArtifact: null,
    ...overrides,
  };
}

describe('deployExitCode', () => {
  it('succeeded is 0', () => {
    expect(deployExitCode(result({ state: 'succeeded' }))).toBe(0);
  });

  it('refused is 2', () => {
    expect(deployExitCode(result({ state: 'refused' }))).toBe(2);
  });

  it('failed is 1', () => {
    expect(deployExitCode(result({ state: 'failed' }))).toBe(1);
  });

  it('rolled_back is 1', () => {
    expect(deployExitCode(result({ state: 'rolled_back' }))).toBe(1);
  });

  it('a passing dry run (verifying, no refusal) is 0', () => {
    expect(deployExitCode(result({ state: 'verifying' }))).toBe(0);
  });
});

describe('formatDeployResult', () => {
  it('prints state, sha, each image, and the schema revision', () => {
    const text = formatDeployResult(
      result({
        state: 'succeeded',
        schemaRevision: 's2',
        images: [
          {
            service: 'app',
            repo: 'registry.shipyard.test/toy/app',
            sha: SHA,
            digest: `sha256:${'b'.repeat(64)}`,
            reference: `registry.shipyard.test/toy/app:sha-${SHA}@sha256:${'b'.repeat(64)}`,
            labels: {},
            migration: null,
          },
        ],
      }),
    );
    expect(text).toContain('state: succeeded');
    expect(text).toContain(`sha: ${SHA}`);
    expect(text).toContain(`app registry.shipyard.test/toy/app@sha256:${'b'.repeat(64)}`);
    expect(text).toContain('schema: s2');
  });

  it('prints a refusal as code (gate): message, then the fix', () => {
    const text = formatDeployResult(
      result({
        state: 'refused',
        refusal: { code: 'not_ahead_of_live', gate: 'G7', message: 'sha is not ahead of live', fix: 'choose a newer sha' },
      }),
    );
    expect(text).toContain('not_ahead_of_live (G7): sha is not ahead of live');
    expect(text).toContain('fix: choose a newer sha');
  });
});

describe('formatProgress', () => {
  it('prints the state alone when there is no step', () => {
    expect(formatProgress({ state: 'verifying' })).toBe('verifying\n');
  });

  it('prints the state and step together', () => {
    expect(formatProgress({ state: 'swapping', step: 'swap' })).toBe('swapping (swap)\n');
  });
});

describe('formatRecovery', () => {
  it('names the deploy and its last step', () => {
    const r: RecoveryResult = { deployId: 'dep-1', app: 'toy', restored: ['app.compose.yml'], upExitCode: 0, lastStep: 'swap' };
    const text = formatRecovery(r);
    expect(text).toContain('recovered toy dep-1');
    expect(text).toContain('last step: swap');
    expect(text).toContain('restored: app.compose.yml');
    expect(text).toContain('compose up exit: 0');
  });

  it('surfaces a per-deploy recovery error', () => {
    const r: RecoveryResult = { deployId: 'dep-2', app: 'toy', restored: [], upExitCode: null, lastStep: undefined, error: 'boom' };
    expect(formatRecovery(r)).toContain('error: boom');
  });
});

describe('formatStatus', () => {
  it('prints the live sha, running containers, and recent ledger entries', () => {
    const running: RunningContainer[] = [
      { id: 'c1', service: 'app', repoDigests: [`registry.shipyard.test/toy/app@sha256:${'c'.repeat(64)}`], labels: {}, state: 'running', networks: [] },
    ];
    const entry = {
      app: 'toy',
      deployId: 'dep-1',
      kind: 'deploy' as const,
      sha: SHA,
      images: [{ service: 'app', repo: 'registry.shipyard.test/toy/app', digest: `sha256:${'c'.repeat(64)}`, migration: null }],
      backupArtifact: null,
      at: '2026-09-24T00:00:00.000Z',
    };
    const text = formatStatus('toy', entry, running, [entry]);
    expect(text).toContain('app: toy');
    expect(text).toContain(`live sha: ${SHA}`);
    expect(text).toContain('app registry.shipyard.test/toy/app@sha256:');
    expect(text).toContain('deploy');
  });

  it('prints (none) when there is no live release', () => {
    expect(formatStatus('toy', null, [], [])).toContain('live sha: (none)');
  });
});
