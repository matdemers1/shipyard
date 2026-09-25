import { describe, expect, it, vi } from 'vitest';

import { main, type CliDeps } from '../src/main.js';

function deps(overrides: Partial<CliDeps> = {}): CliDeps & { stdoutLines: string[]; stderrLines: string[] } {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  return {
    buildPorts: vi.fn(() => {
      throw new Error('buildPorts should not have been called');
    }),
    deployId: () => 'dep-test',
    requesterLabel: () => 'cli@test',
    stdout: { write: (s: string) => stdoutLines.push(s) },
    stderr: { write: (s: string) => stderrLines.push(s) },
    stdoutLines,
    stderrLines,
    ...overrides,
  };
}

const GOOD_ENV = { SHIPYARD_DATA_ROOT: '/data' };

describe('main: argument validation happens before any port is built', () => {
  it('a bad app name is refused (exit 2) without building ports', async () => {
    const d = deps();
    const code = await main(['deploy', 'NOT_VALID', 'a'.repeat(40)], GOOD_ENV, d);
    expect(code).toBe(2);
    expect(d.buildPorts).not.toHaveBeenCalled();
    expect(d.stderrLines.join('')).toContain('invalid app');
  });

  it('a bad sha is refused (exit 2) without building ports', async () => {
    const d = deps();
    const code = await main(['deploy', 'toy', 'not-a-sha'], GOOD_ENV, d);
    expect(code).toBe(2);
    expect(d.buildPorts).not.toHaveBeenCalled();
    expect(d.stderrLines.join('')).toContain('invalid sha');
  });

  it('an unknown command is refused (exit 2) without building ports', async () => {
    const d = deps();
    const code = await main(['nonsense'], GOOD_ENV, d);
    expect(code).toBe(2);
    expect(d.buildPorts).not.toHaveBeenCalled();
  });
});

describe('main: env validation', () => {
  it('a missing SHIPYARD_DATA_ROOT is a config error (exit 1) without building ports', async () => {
    const d = deps();
    const code = await main(['status', 'toy'], {}, d);
    expect(code).toBe(1);
    expect(d.buildPorts).not.toHaveBeenCalled();
    expect(d.stderrLines.join('')).toContain('SHIPYARD_DATA_ROOT');
  });

  it('--help never touches env or ports', async () => {
    const d = deps();
    const code = await main(['--help'], {}, d);
    expect(code).toBe(0);
    expect(d.buildPorts).not.toHaveBeenCalled();
    expect(d.stdoutLines.join('')).toContain('Usage:');
  });

  it('no argv (help) exits 0', async () => {
    const d = deps();
    const code = await main([], {}, d);
    expect(code).toBe(0);
  });
});

describe('main: valid args and env reach buildPorts', () => {
  it('passes the resolved config through to buildPorts', async () => {
    const seen: unknown[] = [];
    const d = deps({
      buildPorts: vi.fn((config: unknown) => {
        seen.push(config);
        throw new Error('stop here: fake ports are not needed for this assertion');
      }),
    });
    await expect(main(['check-manifests'], { SHIPYARD_DATA_ROOT: '/data', GITHUB_TOKEN_AGENT: 'x' }, d)).rejects.toThrow();
    expect(seen).toEqual([expect.objectContaining({ dataRoot: '/data' })]);
  });
});
