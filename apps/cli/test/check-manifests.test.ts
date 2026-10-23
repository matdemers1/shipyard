import { describe, expect, it } from 'vitest';
import type { FsPort, SequencePorts } from '@shipyard/sequence';
import { runCheckManifestsCommand } from '../src/commands.js';

const ROOT = '/data';

const app = (name: string, project: string): string =>
  [
    `name: ${name}`,
    `repo: o/${name}`,
    'workflow: ci.yml',
    'compose:',
    `  files: [/srv/${name}/compose.yml]`,
    `  project: ${project}`,
    'services:',
    `  web: { image: ghcr.io/o/${name} }`,
    'health: { service: web, port: 80, path: /health }',
    '',
  ].join('\n');

const stack = (name: string, project: string): string =>
  ['kind: stack', `name: ${name}`, 'compose:', `  files: [/srv/${name}/compose.yml]`, `  project: ${project}`, ''].join('\n');

function run(files: Record<string, string>) {
  const map = new Map(Object.entries(files));
  const fs: FsPort = {
    readFile: (path) => (map.has(path) ? Promise.resolve(map.get(path) ?? '') : Promise.reject(new Error(`ENOENT ${path}`))),
    writeFileAtomic: () => Promise.reject(new Error('read-only')),
    appendLine: () => Promise.reject(new Error('read-only')),
    exists: (path) => Promise.resolve([...map.keys()].some((p) => p.startsWith(`${path}/`))),
    mkdirp: () => Promise.resolve(),
    list: (dir) => Promise.resolve([...map.keys()].filter((p) => p.startsWith(`${dir}/`)).map((path) => ({ path, size: 1, mtimeMs: 0 }))),
  };
  const out: string[] = [];
  const err: string[] = [];
  const deps = { deployId: () => 'x', requesterLabel: 'test', stdout: { write: (s: string) => void out.push(s) }, stderr: { write: (s: string) => void err.push(s) } };
  return runCheckManifestsCommand({ fs } as unknown as SequencePorts, ROOT, deps as never).then((code) => ({ code, out: out.join(''), err: err.join('') }));
}

describe('check-manifests reads stacks too (SHP-ADR-010)', () => {
  it('lists apps and stacks and exits 0 when they agree', async () => {
    const r = await run({ [`${ROOT}/apps/web.yml`]: app('web', 'web'), [`${ROOT}/stacks/freshrss.yml`]: stack('freshrss', 'freshrss') });
    expect(r.code).toBe(0);
    expect(r.out).toContain('web /data/apps/web.yml');
    expect(r.out).toContain('stack freshrss /data/stacks/freshrss.yml');
  });

  it('exits 1 naming a stack that shares an app name or an app compose project', async () => {
    const r = await run({ [`${ROOT}/apps/web.yml`]: app('web', 'web'), [`${ROOT}/stacks/web.yml`]: stack('web', 'other'), [`${ROOT}/stacks/side.yml`]: stack('side', 'web') });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/stack web has the same name as an app/);
    expect(r.err).toMatch(/stack side names compose project web, already app web's/);
  });

  it('exits 1 on an invalid stack file', async () => {
    const r = await run({ [`${ROOT}/stacks/bad.yml`]: 'kind: stack\nname: bad\ncommand: x\n' });
    expect(r.code).toBe(1);
    expect(r.err.length).toBeGreaterThan(0);
  });
});
