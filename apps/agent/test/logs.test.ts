import { describe, expect, it } from 'vitest';
import { LogsChunk, type LogsJob, type Manifest } from '@shipyard/schema';
import type { ContainerLogLine, ContainerLogsOptions, DockerPort, FsPort, LoadedManifests, LoadedStacks } from '@shipyard/sequence';
import type { AgentClient } from '../src/client.js';
import { LOGS_MAX_BYTES, createLogsRunner, logsChunkPath, type LogsRunnerOptions, type LogsTimers } from '../src/logs.js';

/**
 * SHP-T-15.3 (SHP-REQ-189, SHP-REQ-190): the agent reads a container's logs, redacts them on the
 * host, and posts ordered chunks; it stops at the tail, the follow window, 2 MB, or the server's
 * `continue: false`, and never puts a line of log text in its own log.
 */

const LOGS_ID = '66666666-6666-4666-8666-666666666666';
const CONTAINER = 'c'.repeat(64);
const FILE_SECRET = 'smtp-password-in-env-file';
const ENV_SECRET = 'jwt-secret-in-container-env';

interface Call {
  path: string;
  body: unknown;
}

function fakeClient(answer: (chunk: LogsChunk, index: number) => unknown = () => ({ continue: true })): AgentClient & { calls: Call[]; chunks: () => LogsChunk[] } {
  const calls: Call[] = [];
  return {
    calls,
    chunks: () => calls.filter((c) => c.path === logsChunkPath(LOGS_ID)).map((c) => LogsChunk.parse(c.body)),
    request(_method, path, body) {
      calls.push({ path, body });
      const index = calls.length - 1;
      try {
        return Promise.resolve(answer(LogsChunk.parse(body), index));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
  };
}

function memFs(files: Record<string, string>): FsPort {
  return {
    readFile: (path) => (files[path] === undefined ? Promise.reject(new Error(`ENOENT ${path}`)) : Promise.resolve(files[path])),
    writeFileAtomic: () => Promise.reject(new Error('the logs runner never writes')),
    appendLine: () => Promise.reject(new Error('the logs runner never writes')),
    exists: (path) => Promise.resolve(path in files),
    mkdirp: () => Promise.reject(new Error('the logs runner never writes')),
    list: () => Promise.resolve([]),
  };
}

function apps(): LoadedManifests {
  const manifest = { name: 'mail', compose: { files: ['/srv/mail/compose.yml'], project: 'mail' }, envFiles: ['/srv/mail/.env'] } as unknown as Manifest;
  return new Map([['mail', { manifest, file: '/data/apps/mail.yml', sha256: 'a'.repeat(64) }]]);
}

type LogSource = (options: ContainerLogsOptions) => AsyncIterable<ContainerLogLine>;

function fakeDocker(source: LogSource, opts: { project?: string | null; missing?: boolean } = {}): DockerPort & { logCalls: ContainerLogsOptions[] } {
  const logCalls: ContainerLogsOptions[] = [];
  return {
    logCalls,
    compose: () => Promise.reject(new Error('logs never run compose')),
    containers: () => Promise.resolve([]),
    probeHealth: () => Promise.reject(new Error('unused')),
    freeBytes: () => Promise.resolve(0),
    images: () => Promise.resolve([]),
    removeImage: () => Promise.resolve(),
    inspectEnv: () =>
      Promise.resolve(opts.missing === true ? null : { envValues: [ENV_SECRET, 'production', 'short'], composeProject: opts.project === undefined ? 'mail' : opts.project }),
    containerLogs: (_id, options) => {
      logCalls.push(options);
      return source(options);
    },
  };
}

function line(text: string, stream: 'stdout' | 'stderr' = 'stdout'): ContainerLogLine {
  return { stream, at: '2026-10-22T12:00:00.000Z', text };
}

async function* lines(texts: string[]): AsyncGenerator<ContainerLogLine> {
  await Promise.resolve();
  for (const t of texts) yield line(t);
}

/** Timers driven by the test: nothing fires by itself. */
function manualTimers(): LogsTimers & { windows: { ms: number; fire: () => void }[] } {
  const windows: { ms: number; fire: () => void }[] = [];
  return {
    windows,
    after: (ms, fn) => {
      windows.push({ ms, fire: fn });
      return () => undefined;
    },
    every: () => () => undefined,
  };
}

function job(extra: Partial<LogsJob> = {}): LogsJob {
  return { logsId: LOGS_ID, containerId: CONTAINER, tail: 200, follow: false, followSeconds: 0, ...extra };
}

function setup(source: LogSource, over: Partial<LogsRunnerOptions> & { dockerOpts?: { project?: string | null; missing?: boolean } } = {}) {
  const logged: unknown[] = [];
  const record = (obj: object, msg?: string): void => {
    logged.push({ obj, msg });
  };
  const log = { info: record, warn: record, error: record };
  const docker = fakeDocker(source, over.dockerOpts);
  const client = fakeClient();
  const timers = manualTimers();
  const runner = createLogsRunner({
    client,
    docker,
    fs: memFs({ '/srv/mail/.env': `SMTP_PASSWORD=${FILE_SECRET}\nSMTP_TLS=true\n` }),
    apps: () => Promise.resolve(apps()),
    stacks: () => Promise.resolve(new Map() as LoadedStacks),
    log,
    timers,
    ...over,
  });
  return { runner, docker, client: (over.client as ReturnType<typeof fakeClient> | undefined) ?? client, logged, timers };
}

describe('the logs runner (SHP-REQ-189, SHP-REQ-190)', () => {
  it('redacts an env-file value and an inspected Env value on the agent: neither appears in anything posted', async () => {
    const { runner, client, logged } = setup(() =>
      lines([`connecting with ${FILE_SECRET}`, `signed with ${ENV_SECRET} in production`, 'SMTP_TLS=true short']),
    );
    await runner.run(job());
    const wire = JSON.stringify(client.chunks());
    expect(wire).not.toContain(FILE_SECRET);
    expect(wire).not.toContain(ENV_SECRET);
    const texts = client.chunks().flatMap((c) => c.lines.map((l) => l.text));
    // `production` is longer than eight characters, so it goes too; `true` and `short` stay.
    expect(texts).toEqual(['connecting with [redacted]', 'signed with [redacted] in [redacted]', 'SMTP_TLS=true short']);
    // The agent's own log never carries a line, redacted or not.
    const own = JSON.stringify(logged);
    expect(own).not.toContain('connecting with');
    expect(own).not.toContain(FILE_SECRET);
    expect(own).not.toContain(ENV_SECRET);
  });

  it('sends the tail in ordered chunks of at most 500 lines, the last one done', async () => {
    const { runner, client, docker } = setup(() => lines(Array.from({ length: 1_203 }, (_, i) => `line ${String(i)}`)));
    await runner.run(job({ tail: 2000 }));
    const chunks = client.chunks();
    expect(chunks.map((c) => [c.seq, c.lines.length, c.done])).toEqual([
      [0, 500, false],
      [1, 500, false],
      [2, 203, true],
    ]);
    expect(chunks.flatMap((c) => c.lines.map((l) => l.text))).toEqual(Array.from({ length: 1_203 }, (_, i) => `line ${String(i)}`));
    expect(docker.logCalls).toEqual([expect.objectContaining({ tail: 2000, follow: false })]);
  });

  it('treats follow: false as a tail only, whatever followSeconds says', async () => {
    const { runner, docker, timers } = setup(() => lines(['a']));
    await runner.run(job({ follow: false, followSeconds: 300 }));
    expect(docker.logCalls[0]?.follow).toBe(false);
    expect(timers.windows).toEqual([]);
  });

  it('follows until the followSeconds window ends, then sends a last chunk', async () => {
    const timers = manualTimers();
    const source: LogSource = (options) =>
      (async function* () {
        yield line('before');
        yield line('more');
        // The window ends here: the stream must stop on the abort.
        timers.windows[0]?.fire();
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted === true) resolve();
          options.signal?.addEventListener('abort', () => {
            resolve();
          });
        });
      })();
    const { runner, client, docker } = setup(source, { timers });
    await runner.run(job({ follow: true, followSeconds: 45 }));
    expect(timers.windows.map((w) => w.ms)).toEqual([45_000]);
    expect(docker.logCalls[0]?.follow).toBe(true);
    const chunks = client.chunks();
    expect(chunks.at(-1)).toMatchObject({ done: true });
    expect(chunks.flatMap((c) => c.lines.map((l) => l.text))).toEqual(['before', 'more']);
  });

  it('stops at 2 MB of text sent', async () => {
    const big = 'x'.repeat(16_000);
    const { runner, client } = setup(() =>
      (async function* () {
        await Promise.resolve();
        for (let i = 0; i < 10_000; i++) yield line(big);
      })(),
    );
    await runner.run(job({ tail: 2000 }));
    const sent = client.chunks().flatMap((c) => c.lines);
    const bytes = sent.reduce((n, l) => n + Buffer.byteLength(l.text), 0);
    expect(bytes).toBeLessThanOrEqual(LOGS_MAX_BYTES);
    expect(bytes).toBeGreaterThan(LOGS_MAX_BYTES - big.length);
    expect(client.chunks().at(-1)?.done).toBe(true);
  });

  it('caps a line at 16 KiB after redacting it', async () => {
    const { runner, client } = setup(() => lines([`${'y'.repeat(16_380)}${ENV_SECRET}`]));
    await runner.run(job());
    const [only] = client.chunks().flatMap((c) => c.lines);
    expect(only?.text.length).toBe(16_384);
    expect(only?.text).not.toContain(ENV_SECRET.slice(0, 4));
  });

  it("stops when the server answers continue: false, and sends nothing after", async () => {
    let produced = 0;
    const client = fakeClient((_chunk, i) => ({ continue: i < 1 }));
    const { runner } = setup(
      (options) =>
        (async function* () {
          await Promise.resolve();
          while (options.signal?.aborted !== true && produced < 100_000) {
            produced++;
            yield line(`l${String(produced)}`);
          }
        })(),
      { client, chunkLines: 10 },
    );
    await runner.run(job({ follow: true, followSeconds: 300 }));
    const chunks = client.chunks();
    expect(chunks.map((c) => c.seq)).toEqual([0, 1]);
    expect(chunks.every((c) => !c.done)).toBe(true);
    expect(produced).toBeLessThan(100);
  });

  it('refuses an unknown container in a single done chunk', async () => {
    const { runner, client, docker } = setup(() => lines(['never read']), { dockerOpts: { missing: true } });
    await runner.run(job());
    expect(client.chunks()).toHaveLength(1);
    expect(client.chunks()[0]).toMatchObject({ logsId: LOGS_ID, seq: 0, lines: [], done: true, error: { code: 'unknown_container' } });
    expect(docker.logCalls).toEqual([]);
  });

  it('reads any container, whatever its tier; one with no compose project redacts its Env values', async () => {
    const { runner, client } = setup(() => lines([`x ${ENV_SECRET}`]), { dockerOpts: { project: null } });
    await runner.run(job());
    expect(client.chunks().flatMap((c) => c.lines.map((l) => l.text))).toEqual(['x [redacted]']);
  });

  it('refuses rather than sends lines it cannot redact: an unreadable env file', async () => {
    const { runner, client, docker } = setup(() => lines([FILE_SECRET]), { fs: memFs({}) });
    await runner.run(job());
    expect(client.chunks()).toHaveLength(1);
    expect(client.chunks()[0]).toMatchObject({ seq: 0, done: true, lines: [], error: { code: 'manifest_invalid' } });
    expect(docker.logCalls).toEqual([]);
  });

  it('refuses a fourth stream while three are open', async () => {
    const releases: (() => void)[] = [];
    const source: LogSource = () =>
      (async function* () {
        await new Promise<void>((r) => releases.push(r));
        yield line('done');
      })();
    const { runner, client } = setup(source);
    const open = [1, 2, 3].map((n) => runner.run(job({ logsId: `6666666${String(n)}-6666-4666-8666-666666666666` })));
    await new Promise((r) => setTimeout(r, 5));
    expect(runner.active()).toBe(3);
    await runner.run(job());
    expect(client.chunks()).toHaveLength(1);
    expect(client.chunks()[0]).toMatchObject({ seq: 0, done: true, error: { code: 'conflict' } });
    for (const release of releases) release();
    await Promise.all(open);
    expect(runner.active()).toBe(0);
  });

  it('ends with an error chunk when the Engine breaks the stream', async () => {
    const { runner, client } = setup(() =>
      (async function* () {
        await Promise.resolve();
        yield line('one');
        throw new Error('socket hang up');
      })(),
    );
    await runner.run(job());
    expect(client.chunks().at(-1)).toMatchObject({ done: true, lines: [{ text: 'one' }], error: { code: 'action_failed' } });
  });
});
