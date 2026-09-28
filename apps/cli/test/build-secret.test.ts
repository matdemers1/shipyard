import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentKeyPath, buildSecretsPath, readBuildSecrets } from '@shipyard/sequence';

import { SECRET_ON_ARGV, parseArgs } from '../src/args.js';
import { main, type CliDeps } from '../src/main.js';

const VALUE = 'ghp_cli_secret_value_0123456789';

function deps(stdin: string): CliDeps & { out: string[]; err: string[]; readStdin: ReturnType<typeof vi.fn> } {
  const out: string[] = [];
  const err: string[] = [];
  const readStdin = vi.fn(() => Promise.resolve(stdin));
  return {
    buildPorts: vi.fn(() => {
      throw new Error('build-secret must not build Docker/GitHub ports');
    }),
    deployId: () => 'dep-test',
    requesterLabel: () => 'cli@test',
    stdout: { write: (s: string) => out.push(s) },
    stderr: { write: (s: string) => err.push(s) },
    readStdin,
    out,
    err,
  };
}

describe('parseArgs: build-secret', () => {
  it('parses set, delete and list', () => {
    expect(parseArgs(['build-secret', 'set', 'toy', 'npm_token'])).toEqual({
      ok: true,
      command: { kind: 'build-secret', action: 'set', app: 'toy', name: 'npm_token' },
    });
    expect(parseArgs(['build-secret', 'delete', 'toy', 'npm_token'])).toMatchObject({ ok: true, command: { action: 'delete' } });
    expect(parseArgs(['build-secret', 'list', 'toy'])).toEqual({ ok: true, command: { kind: 'build-secret', action: 'list', app: 'toy' } });
  });

  it('doneWhen: refuses a secret value on argv, naming why, without echoing it', () => {
    for (const argv of [
      ['build-secret', 'set', 'toy', 'npm_token', VALUE],
      ['build-secret', 'set', 'toy', 'npm_token', '--value', VALUE],
      ['build-secret', 'set', 'toy', 'npm_token', `--value=${VALUE}`],
      ['build-secret', 'set', 'toy', `--value=${VALUE}`],
    ]) {
      const result = parseArgs(argv);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.message).toBe(SECRET_ON_ARGV);
      expect(!result.ok && result.message).not.toContain(VALUE);
    }
    expect(SECRET_ON_ARGV).toContain('stdin');
  });

  it('does not echo an invalid name (it may be a value in the wrong place)', () => {
    const result = parseArgs(['build-secret', 'set', 'toy', 'GHP_VALUE_IN_THE_NAME_SLOT']);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).not.toContain('GHP_VALUE');
  });

  it('refuses a bad app, a missing name, and an unknown action', () => {
    expect(parseArgs(['build-secret', 'set', 'Bad App', 'x']).ok).toBe(false);
    expect(parseArgs(['build-secret', 'set', 'toy']).ok).toBe(false);
    expect(parseArgs(['build-secret', 'show', 'toy', 'x']).ok).toBe(false);
    expect(parseArgs(['build-secret', 'list']).ok).toBe(false);
  });
});

describe('main: build-secret against a real data root', () => {
  let root: string;
  const key = generateKeyPairSync('ed25519').privateKey;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cli-build-secret-'));
    await mkdir(join(root, 'agent'), { recursive: true });
    await writeFile(agentKeyPath(root), key.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('set reads the value from stdin (one trailing newline dropped), seals it, and never prints it', async () => {
    const d = deps(`${VALUE}\n`);
    expect(await main(['build-secret', 'set', 'toy', 'npm_token'], { SHIPYARD_DATA_ROOT: root }, d)).toBe(0);
    expect(d.readStdin).toHaveBeenCalledOnce();
    expect(d.buildPorts).not.toHaveBeenCalled();
    expect([...d.out, ...d.err].join('')).not.toContain(VALUE);
    expect((await readBuildSecrets(root, key, 'toy')).get('npm_token')).toBe(VALUE);
    expect(await readFile(buildSecretsPath(root), 'utf8')).not.toContain(VALUE);

    const list = deps('');
    expect(await main(['build-secret', 'list', 'toy'], { SHIPYARD_DATA_ROOT: root }, list)).toBe(0);
    expect(list.out.join('')).toBe('npm_token\n');
    expect(list.readStdin).not.toHaveBeenCalled();

    const del = deps('');
    expect(await main(['build-secret', 'delete', 'toy', 'npm_token'], { SHIPYARD_DATA_ROOT: root }, del)).toBe(0);
    expect(await readBuildSecrets(root, key, 'toy')).toEqual(new Map());
  });

  it('a value on argv exits 2 before reading stdin or touching the store', async () => {
    const d = deps(VALUE);
    expect(await main(['build-secret', 'set', 'toy', 'npm_token', VALUE], { SHIPYARD_DATA_ROOT: root }, d)).toBe(2);
    expect(d.readStdin).not.toHaveBeenCalled();
    expect(d.err.join('')).toContain('stdin');
    expect(d.err.join('')).not.toContain(VALUE);
    await expect(readFile(buildSecretsPath(root), 'utf8')).rejects.toThrow();
  });

  it('an empty stdin is refused', async () => {
    const d = deps('\n');
    expect(await main(['build-secret', 'set', 'toy', 'npm_token'], { SHIPYARD_DATA_ROOT: root }, d)).toBe(2);
  });

  it('without the agent key it says how to get one', async () => {
    await rm(agentKeyPath(root));
    const d = deps(VALUE);
    expect(await main(['build-secret', 'set', 'toy', 'npm_token'], { SHIPYARD_DATA_ROOT: root }, d)).toBe(1);
    expect(d.err.join('')).toContain('no agent key');
  });
});
