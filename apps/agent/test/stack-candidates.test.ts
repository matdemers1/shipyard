import { describe, expect, it } from 'vitest';
import { StackManifest } from '@shipyard/schema';
import { RegistryError, createOciRegistry, type DockerPort, type RunningContainer, type StackRegistryPort } from '@shipyard/sequence';
import { CANDIDATE_RECHECK_MS, createCandidateChecker } from '../src/stack-candidates.js';

// SHP-REQ-194: each tracked service's track resolved on the report interval, cached, rate-limit
// aware, never holding the heartbeat; a candidate when it differs from what runs.

const d = (c: string): string => `sha256:${c.repeat(64)}`;
const RUNNING = d('1');
const NEW = d('2');

const STACK = parseDigestStack({
  kind: 'stack',
  name: 'media',
  compose: { files: ['/srv/media/compose.yml'], project: 'media' },
  updates: 'digest',
  services: {
    web: { image: 'lscr.io/linuxserver/sonarr', track: { tag: 'latest' } },
    db: { image: 'postgres', track: { semver: '16.x' } },
    cache: { image: 'redis', track: 'pinned' },
  },
});

function parseDigestStack(input: unknown): Extract<StackManifest, { updates: 'digest' }> {
  const parsed = StackManifest.parse(input);
  if (parsed.updates !== 'digest') throw new Error('not a digest-updated stack');
  return parsed;
}

function docker(running: Record<string, string>): DockerPort {
  const containers = (): Promise<RunningContainer[]> =>
    Promise.resolve(
      Object.entries(running).map(([service, ref]) => ({ id: `c-${service}`, service, repoDigests: [ref], labels: {}, state: 'running', networks: [] })),
    );
  return {
    compose: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
    containers,
    probeHealth: () => Promise.reject(new Error('unused')),
    freeBytes: () => Promise.resolve(0),
    images: () => Promise.resolve([]),
    removeImage: () => Promise.resolve(),
  };
}

interface FakeRegistry extends StackRegistryPort {
  calls: string[];
  digests: Map<string, string>;
  fail: Error | null;
  hold: Promise<void> | null;
}

function registry(): FakeRegistry {
  const r: FakeRegistry = {
    calls: [],
    digests: new Map([
      ['lscr.io/linuxserver/sonarr:latest', NEW],
      ['postgres:16.4', d('4')],
    ]),
    fail: null,
    hold: null,
    async resolveDigest(image, tag) {
      r.calls.push(`${image}:${tag}`);
      if (r.hold !== null) await r.hold;
      if (r.fail !== null) throw r.fail;
      return (r.digests.get(`${image}:${tag}`) ?? null);
    },
    async listTags(image) {
      r.calls.push(`tags ${image}`);
      if (r.hold !== null) await r.hold;
      if (r.fail !== null) throw r.fail;
      return image === 'postgres' ? ['16', '16.3', '16.4', '17.0'] : [];
    },
  };
  return r;
}

const RUNS = { web: `lscr.io/linuxserver/sonarr@${RUNNING}`, db: `postgres@${d('4')}`, cache: `redis@${d('6')}` };

describe('candidate checker', () => {
  it('reports running digests and a candidate only where the track resolves elsewhere; pinned asks nothing', async () => {
    const reg = registry();
    const checker = createCandidateChecker({ registry: reg, docker: docker(RUNS), now: () => 1_000 });
    const services = await checker.services(STACK);
    expect(services).toEqual({
      web: { running: RUNNING, candidate: { tag: 'latest', digest: NEW }, checkedAt: new Date(1_000).toISOString(), error: null },
      db: { running: d('4'), candidate: null, checkedAt: new Date(1_000).toISOString(), error: null },
      cache: { running: d('6'), candidate: null, checkedAt: new Date(1_000).toISOString(), error: null },
    });
    expect(reg.calls.filter((c) => c.startsWith('redis'))).toEqual([]);
  });

  it('asks the registry at most every 30 minutes, at once after invalidate, and when the track changes', async () => {
    const reg = registry();
    let now = 0;
    const checker = createCandidateChecker({ registry: reg, docker: docker(RUNS), now: () => now });
    await checker.services(STACK);
    const first = reg.calls.length;
    now += CANDIDATE_RECHECK_MS - 1;
    await checker.services(STACK);
    expect(reg.calls).toHaveLength(first);
    now += 1;
    await checker.services(STACK);
    expect(reg.calls.length).toBeGreaterThan(first);

    const second = reg.calls.length;
    checker.invalidate('media');
    await checker.services(STACK);
    expect(reg.calls.length).toBeGreaterThan(second);

    const third = reg.calls.length;
    const edited = StackManifest.parse({ ...STACK, services: { ...STACK.services, web: { image: 'lscr.io/linuxserver/sonarr', track: { tag: 'develop' } } } });
    await checker.services(edited);
    expect(reg.calls.slice(third)).toEqual(['lscr.io/linuxserver/sonarr:develop']);
  });

  it('a 429 is the service’s error and backs off for Retry-After; the last answer is kept', async () => {
    const reg = registry();
    let now = 0;
    const checker = createCandidateChecker({ registry: reg, docker: docker(RUNS), now: () => now });
    await checker.services(STACK);
    reg.fail = new RegistryError('rate_limited', 'registry-1.docker.io is rate limiting (429)', 60 * 60_000);
    now += CANDIDATE_RECHECK_MS;
    const limited = await checker.services(STACK);
    expect(limited?.['web']).toMatchObject({ candidate: { digest: NEW }, error: expect.stringContaining('rate limiting') as unknown });
    const calls = reg.calls.length;
    now += 59 * 60_000;
    await checker.services(STACK);
    expect(reg.calls).toHaveLength(calls);
    reg.fail = null;
    now += 60_000;
    expect((await checker.services(STACK))?.['web']?.error).toBeNull();
  });

  it('an unreachable registry or a range with no tag is an error, never a crash', async () => {
    const reg = registry();
    reg.fail = new RegistryError('unreachable', 'ghcr.io unreachable (fetch failed)');
    const checker = createCandidateChecker({ registry: reg, docker: docker(RUNS), now: () => 0 });
    const services = await checker.services(STACK);
    expect(services?.['web']).toMatchObject({ candidate: null, error: expect.stringContaining('unreachable') as unknown });
    const none = createCandidateChecker({ registry: registry(), docker: docker(RUNS), now: () => 0 });
    const edited = StackManifest.parse({ ...STACK, services: { db: { image: 'postgres', track: { semver: '19.x' } } } });
    expect((await none.services(edited))?.['db']).toMatchObject({ candidate: null, error: expect.stringContaining('19.x') as unknown });
  });

  it('never holds the report past its deadline: a slow registry answers on a later report', async () => {
    const reg = registry();
    let release = (): void => undefined;
    reg.hold = new Promise((resolve) => {
      release = resolve;
    });
    const checker = createCandidateChecker({ registry: reg, docker: docker(RUNS), now: () => 0, deadlineMs: 20 });
    const started = Date.now();
    const first = await checker.services(STACK);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(first?.['web']).toEqual({ running: RUNNING, candidate: null, checkedAt: null, error: null });
    const calls = reg.calls.length;
    // A report while the check is still running starts no second one.
    await checker.services(STACK);
    expect(reg.calls).toHaveLength(calls);
    reg.hold = null;
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect((await checker.services(STACK))?.['web']?.candidate).toEqual({ tag: 'latest', digest: NEW });
  });

  it('a lifecycle-only stack has no services', async () => {
    const checker = createCandidateChecker({ registry: registry(), docker: docker(RUNS) });
    expect(await checker.services(StackManifest.parse({ kind: 'stack', name: 'x', compose: STACK.compose }))).toBeUndefined();
  });

  describe('a semver track never offers a downgrade (SHP-REQ-195)', () => {
    const composeWith = (dbLine: string): { readFile: (path: string) => Promise<string> } => ({
      readFile: (path) =>
        path === '/srv/media/compose.yml'
          ? Promise.resolve(`services:\n  web:\n    image: lscr.io/linuxserver/sonarr:4.0.0\n  db:\n    image: ${dbLine}\n  cache:\n    image: redis@${d('6')}\n`)
          : Promise.reject(new Error('no such file')),
    });
    // db runs something other than what 16.x resolves to (16.4 → d('4')).
    const runs = { ...RUNS, db: `postgres@${d('9')}` };

    it('no candidate when the image line names a higher version than the track resolves to', async () => {
      const checker = createCandidateChecker({ registry: registry(), docker: docker(runs), fs: composeWith(`postgres:17.0@${d('9')}`), now: () => 0 });
      const services = await checker.services(STACK);
      expect(services?.['db']).toMatchObject({ running: d('9'), candidate: null, error: null });
      // A { tag } track is a moving tag: its digest changing is the update, whatever the tag reads.
      expect(services?.['web']?.candidate).toEqual({ tag: 'latest', digest: NEW });
    });

    it('a candidate when the running version is lower', async () => {
      const checker = createCandidateChecker({ registry: registry(), docker: docker(runs), fs: composeWith('postgres:16.3'), now: () => 0 });
      expect((await checker.services(STACK))?.['db']?.candidate).toEqual({ tag: '16.4', digest: d('4') });
    });

    it('a running tag that is not a version, or a compose file it cannot read, keeps today’s behaviour', async () => {
      const latest = createCandidateChecker({ registry: registry(), docker: docker(runs), fs: composeWith('postgres:latest'), now: () => 0 });
      expect((await latest.services(STACK))?.['db']?.candidate).toEqual({ tag: '16.4', digest: d('4') });
      const unreadable = createCandidateChecker({ registry: registry(), docker: docker(runs), fs: { readFile: () => Promise.reject(new Error('EACCES')) }, now: () => 0 });
      expect((await unreadable.services(STACK))?.['db']?.candidate).toEqual({ tag: '16.4', digest: d('4') });
    });
  });

  it('a registry whose body stalls clears the check: the next report starts a new one (SHP-REQ-196)', async () => {
    const stalled = new Response(new ReadableStream({ start: () => undefined }), { status: 200 });
    const reg = createOciRegistry({ fetch: () => Promise.resolve(stalled.clone()), timeoutMs: 50 });
    let now = 0;
    const checker = createCandidateChecker({ registry: reg, docker: docker(RUNS), now: () => now, deadlineMs: 2_000, errorRetryMs: 1 });
    const first = await checker.services(STACK);
    expect(first?.['db']).toMatchObject({ candidate: null, error: expect.stringContaining('timed out') as unknown });
    now += 10;
    const second = await checker.services(STACK);
    expect(second?.['db']?.checkedAt).toBe(new Date(10).toISOString());
  });
});
