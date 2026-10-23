import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';

import type Dockerode from 'dockerode';
import { describe, expect, it } from 'vitest';

import { createDockerAdapter, DockerLogDecoder, MAX_LOG_LINE_CHARS, splitLogTimestamp } from '../src/adapters/docker.js';
import { ACTION_STEP, Journal } from '../src/journal.js';
import { loadStacks, ManifestLoadError } from '../src/manifest.js';
import type { Clock, ContainerLogLine, FsPort, Log } from '../src/ports.js';
import { REDACTED, createRedactor, redactionValues, safeCut } from '../src/redact.js';

/**
 * SHP-T-15.3: stack manifests under `<data root>/stacks/` (SHP-REQ-183), the action journal bracket
 * (SHP-REQ-187), log redaction (SHP-REQ-190) and the Docker port's log read (SHP-REQ-189).
 */

function memoryFs(files: Record<string, string>): FsPort & { files: Record<string, string> } {
  return {
    files,
    readFile: (path) => {
      const content = files[path];
      return content === undefined ? Promise.reject(new Error(`ENOENT: ${path}`)) : Promise.resolve(content);
    },
    writeFileAtomic: (path, content) => {
      files[path] = content;
      return Promise.resolve();
    },
    appendLine: (path, line) => {
      files[path] = `${files[path] ?? ''}${line}\n`;
      return Promise.resolve();
    },
    exists: (path) => Promise.resolve(Object.keys(files).some((p) => p === path || p.startsWith(`${path}/`))),
    mkdirp: () => Promise.resolve(),
    list: (dir) => {
      const prefix = `${dir}/`;
      const direct = Object.keys(files).filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'));
      return Promise.resolve(direct.map((path) => ({ path, size: files[path]?.length ?? 0, mtimeMs: 0 })));
    },
  };
}

const ROOT = '/data';
const IMMICH = ['kind: stack', 'name: immich', 'compose:', '  files: [/DATA/AppData/immich/docker-compose.yml]', '  project: immich', 'envFiles: [/DATA/AppData/immich/.env]', ''].join('\n');
const JELLYFIN = ['kind: stack', 'name: jellyfin', 'compose:', '  files: [/DATA/AppData/jellyfin/docker-compose.yml]', '  project: big-bear-jellyfin', ''].join('\n');

describe('loadStacks (SHP-REQ-183)', () => {
  it('loads every stack manifest with the hash of its exact bytes; updates defaults to none', async () => {
    const fs = memoryFs({ [`${ROOT}/stacks/immich.yml`]: IMMICH, [`${ROOT}/stacks/jellyfin.yaml`]: JELLYFIN, [`${ROOT}/stacks/notes.txt`]: 'ignored' });
    const stacks = await loadStacks(fs, ROOT);
    expect([...stacks.keys()].sort()).toEqual(['immich', 'jellyfin']);
    const immich = stacks.get('immich');
    expect(immich?.manifest).toEqual({
      kind: 'stack',
      name: 'immich',
      compose: { files: ['/DATA/AppData/immich/docker-compose.yml'], project: 'immich' },
      envFiles: ['/DATA/AppData/immich/.env'],
      updates: 'none',
    });
    expect(immich?.sha256).toBe(createHash('sha256').update(IMMICH).digest('hex'));
    expect(immich?.file).toBe(`${ROOT}/stacks/immich.yml`);
  });

  it('is all-or-nothing: one invalid file refuses them all, naming the file and field', async () => {
    const fs = memoryFs({
      [`${ROOT}/stacks/immich.yml`]: IMMICH,
      [`${ROOT}/stacks/broken.yml`]: ['kind: stack', 'name: broken', 'compose:', '  files: [relative.yml]', '  project: broken', 'surprise: 1', ''].join('\n'),
      [`${ROOT}/stacks/other.yml`]: JELLYFIN,
    });
    const err = await loadStacks(fs, ROOT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManifestLoadError);
    const issues = (err as ManifestLoadError).issues;
    expect(issues).toContainEqual({ file: `${ROOT}/stacks/broken.yml`, path: 'surprise', message: 'unrecognized key "surprise"' });
    expect(issues.some((i) => i.file === `${ROOT}/stacks/broken.yml` && i.path === 'compose.files[0]')).toBe(true);
    // Named after its file, like an app manifest.
    expect(issues).toContainEqual({ file: `${ROOT}/stacks/other.yml`, path: 'name', message: 'manifest name "jellyfin" does not match filename "other"' });
    expect((err as ManifestLoadError).toRefusal().code).toBe('manifest_invalid');
  });

  it('refuses an app manifest put in stacks/ (kind must be stack)', async () => {
    const fs = memoryFs({ [`${ROOT}/stacks/web.yml`]: 'name: web\nrepo: o/web\n' });
    await expect(loadStacks(fs, ROOT)).rejects.toBeInstanceOf(ManifestLoadError);
  });

  it('a data root with no stacks/ directory has no stacks', async () => {
    expect((await loadStacks(memoryFs({ [`${ROOT}/apps/web.yml`]: 'x' }), ROOT)).size).toBe(0);
  });
});

describe('log and action redaction (SHP-REQ-190)', () => {
  it('takes every non-trivial env-file value and every Env value longer than eight characters', () => {
    const values = redactionValues(
      new Map([
        ['DB_PASSWORD', 'hunter2-long'],
        ['DEBUG', 'true'],
        ['SHORT', 'abcd'],
      ]),
      ['production', '3000', 'eight888', 'nine99999'],
    );
    expect(values.sort()).toEqual(['abcd', 'hunter2-long', 'nine99999', 'production'].sort());
  });

  it('adds each line of eight or more characters of a multi-line value, so a PEM key is caught line by line', () => {
    const pem = ['-----BEGIN PRIVATE KEY-----', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7', 'shortln', '-----END PRIVATE KEY-----'].join('\n');
    const values = redactionValues(new Map([['TLS_KEY', 'line-one-of-file\r\nline-two-of-file']]), [pem]);
    expect(values).toContain(pem);
    expect(values).toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7');
    expect(values).toContain('-----BEGIN PRIVATE KEY-----');
    expect(values).toContain('line-one-of-file');
    expect(values).toContain('line-two-of-file');
    expect(values).not.toContain('shortln');
  });

  it('safeCut moves a cut back past any secret that would straddle it', () => {
    const text = 'aaaaSECRET-VALUEbbbb';
    expect(safeCut(text, ['SECRET-VALUE'], 10)).toBe(4);
    expect(safeCut(text, ['SECRET-VALUE'], 4)).toBe(4);
    expect(safeCut(text, ['SECRET-VALUE'], 18)).toBe(18);
    expect(safeCut(text, ['other'], 10)).toBe(10);
  });

  it('replaces each value with [redacted], longest first, in one pass', () => {
    const redact = createRedactor(['s3cret-value', 's3cret-value-and-more', 'a.b*c']);
    expect(redact('x s3cret-value-and-more y s3cret-value z a.b*c q abc')).toBe(`x ${REDACTED} y ${REDACTED} z ${REDACTED} q abc`);
    expect(createRedactor([])('unchanged')).toBe('unchanged');
  });
});

describe('the action journal bracket (SHP-REQ-187)', () => {
  const clock: Clock = { now: () => new Date('2026-10-22T12:00:00Z'), sleep: () => Promise.resolve() };
  const quiet: Log = { info: () => undefined, warn: () => undefined, error: () => undefined, child: () => quiet };

  it('lists an action started and never ended, and never treats it as an unfinished deploy', async () => {
    const fs = memoryFs({});
    const journal = new Journal(fs, '/data/agent/journal.jsonl', clock, quiet);
    await journal.begin({ deployId: 'act-1', app: 'web', step: ACTION_STEP, argv: ['restart', 'web'], detail: { verb: 'restart' } });
    await journal.end({ deployId: 'act-1', app: 'web', step: ACTION_STEP, exitCode: 0 });
    await journal.begin({ deployId: 'act-2', app: 'immich', step: ACTION_STEP, argv: ['stop'], detail: { verb: 'stop' } });
    expect(await journal.unfinishedActions()).toEqual([{ actionId: 'act-2', name: 'immich', detail: { verb: 'stop' } }]);
    // Restart recovery reads unfinished() and must never roll an app back for an action.
    expect(await journal.unfinished()).toEqual([]);
  });
});

/** Frames a payload the way Docker multiplexes non-TTY logs. */
function frame(stream: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt8(stream, 0);
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe('DockerLogDecoder', () => {
  it('splits Docker timestamps to the millisecond, and leaves a line without one alone', () => {
    expect(splitLogTimestamp('2026-10-22T12:00:01.123456789Z hello world')).toEqual({ at: '2026-10-22T12:00:01.123Z', text: 'hello world' });
    expect(splitLogTimestamp('2026-10-22T12:00:01Z x')).toEqual({ at: '2026-10-22T12:00:01.000Z', text: 'x' });
    expect(splitLogTimestamp('no timestamp here')).toEqual({ at: null, text: 'no timestamp here' });
  });

  it('demultiplexes frames, lines and UTF-8 characters split across any chunk boundary', () => {
    const bytes = Buffer.concat([
      frame(1, '2026-10-22T12:00:00.000000001Z first line\n2026-10-22T12:00:00.5Z sec'),
      frame(2, '2026-10-22T12:00:01Z an error\r\n'),
      frame(1, 'ond line ✓\n'),
    ]);
    const decoder = new DockerLogDecoder(false);
    const out: ContainerLogLine[] = [];
    // One byte at a time: every header, payload and multi-byte character is split.
    for (let i = 0; i < bytes.length; i++) out.push(...decoder.push(bytes.subarray(i, i + 1)));
    out.push(...decoder.end());
    expect(out).toEqual([
      { stream: 'stdout', at: '2026-10-22T12:00:00.000Z', text: 'first line' },
      { stream: 'stderr', at: '2026-10-22T12:00:01.000Z', text: 'an error' },
      { stream: 'stdout', at: '2026-10-22T12:00:00.500Z', text: 'second line ✓' },
    ]);
  });

  it('keeps a line past the old 64 KiB cut whole, so a secret straddling 64 KiB is redacted', () => {
    const secret = 'straddling-secret-value';
    const decoder = new DockerLogDecoder(false);
    const text = `${'x'.repeat(64 * 1024 - 5)}${secret} end`;
    const out = [...decoder.push(frame(1, `2026-10-22T12:00:00Z ${text}\n`)), ...decoder.end()];
    expect(out).toHaveLength(1);
    expect(out[0]?.continues).toBeUndefined();
    const redact = createRedactor([secret]);
    expect(redact(out[0]?.text ?? '')).not.toContain(secret.slice(0, 5));
  });

  it('cuts only a line longer than 1 MiB, flags the piece as continuing, and parses no timestamp off the continuation', () => {
    const decoder = new DockerLogDecoder(true);
    // The line's newline has not arrived yet when the decoder must give the piece up.
    const out = [
      ...decoder.push(Buffer.from(`2026-10-22T12:00:00Z ${'y'.repeat(MAX_LOG_LINE_CHARS)}2026-10-22T12:00:09Z`)),
      ...decoder.push(Buffer.from(' tail\n')),
      ...decoder.end(),
    ];
    expect(out.map((l) => [l.at, l.text.length, l.continues])).toEqual([
      ['2026-10-22T12:00:00.000Z', MAX_LOG_LINE_CHARS - 21, true],
      [null, 21 + '2026-10-22T12:00:09Z tail'.length, undefined],
    ]);
    // Continuation text is kept as it is, a timestamp-looking start included.
    expect(out[1]?.text).toBe(`${'y'.repeat(21)}2026-10-22T12:00:09Z tail`);
  });

  it('reads a TTY container as raw stdout and flushes a last line with no newline', () => {
    const decoder = new DockerLogDecoder(true);
    expect([...decoder.push(Buffer.from('2026-10-22T12:00:00Z a\nb')), ...decoder.end()]).toEqual([
      { stream: 'stdout', at: '2026-10-22T12:00:00.000Z', text: 'a' },
      { stream: 'stdout', at: null, text: 'b' },
    ]);
  });
});

describe('the Docker adapter: containerLogs and inspectEnv (read-only)', () => {
  const ID = 'a'.repeat(64);

  function fakeDockerode(opts: { logs?: Buffer; stream?: PassThrough; tty?: boolean; missing?: boolean; env?: string[] | null; labels?: Record<string, string> | null }) {
    const logCalls: unknown[] = [];
    const docker = {
      getContainer: (id: string) => ({
        inspect: () =>
          opts.missing === true
            ? Promise.reject(Object.assign(new Error('no such container'), { statusCode: 404 }))
            : Promise.resolve({ Id: id, Config: { Tty: opts.tty ?? false, Env: opts.env ?? [], Labels: opts.labels ?? {} }, State: {} }),
        logs: (o: { follow?: boolean }) => {
          logCalls.push(o);
          return Promise.resolve(o.follow === true ? opts.stream : opts.logs);
        },
      }),
    };
    return { docker: docker as unknown as Dockerode, logCalls };
  }

  it('reads the tail with timestamps from both streams, demultiplexed', async () => {
    const f = fakeDockerode({ logs: Buffer.concat([frame(1, '2026-10-22T12:00:00Z out\n'), frame(2, '2026-10-22T12:00:01Z err\n')]) });
    const adapter = createDockerAdapter({ docker: f.docker });
    const lines: ContainerLogLine[] = [];
    for await (const line of adapter.containerLogs(ID, { tail: 200, follow: false, since: '2026-10-22T11:00:00Z' })) lines.push(line);
    expect(lines.map((l) => `${l.stream}:${l.text}`)).toEqual(['stdout:out', 'stderr:err']);
    expect(f.logCalls).toEqual([{ stdout: true, stderr: true, timestamps: true, tail: 200, since: Date.parse('2026-10-22T11:00:00Z') / 1000, follow: false }]);
  });

  it('follows a stream until the signal aborts, without throwing', async () => {
    const stream = new PassThrough();
    const f = fakeDockerode({ stream });
    const adapter = createDockerAdapter({ docker: f.docker });
    const abort = new AbortController();
    const lines: string[] = [];
    const reading = (async () => {
      for await (const line of adapter.containerLogs(ID, { tail: 10, follow: true, signal: abort.signal })) {
        lines.push(line.text);
        if (lines.length === 2) abort.abort();
      }
    })();
    stream.write(frame(1, '2026-10-22T12:00:00Z one\n'));
    stream.write(frame(1, '2026-10-22T12:00:01Z two\n'));
    await reading;
    expect(lines).toEqual(['one', 'two']);
    expect(stream.destroyed).toBe(true);
  });

  it('inspectEnv gives Env values only, and the compose project; null for an unknown container', async () => {
    const f = fakeDockerode({ env: ['TOY_SECRET=not-a-real-secret', 'EMPTY=', 'NOVALUE', 'URL=postgres://u:p@db/x?a=b'], labels: { 'com.docker.compose.project': 'toy' } });
    const adapter = createDockerAdapter({ docker: f.docker });
    expect(await adapter.inspectEnv(ID)).toEqual({ envValues: ['not-a-real-secret', 'postgres://u:p@db/x?a=b'], composeProject: 'toy' });
    expect(await createDockerAdapter({ docker: fakeDockerode({ missing: true }).docker }).inspectEnv(ID)).toBeNull();
    expect(await createDockerAdapter({ docker: fakeDockerode({ env: null, labels: null }).docker }).inspectEnv(ID)).toEqual({ envValues: [], composeProject: null });
  });
});
