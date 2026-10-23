import { LOGS_MAX_FOLLOW_SECONDS, LogsChunkAck, refusal, type LogLine, type LogsChunk, type LogsJob, type Refusal } from '@shipyard/schema';
import {
  ManifestLoadError,
  createRedactor,
  loadSecrets,
  redactionValues,
  type DockerPort,
  type FsPort,
  type LoadedManifests,
  type LoadedStacks,
} from '@shipyard/sequence';
import type { AgentClient } from './client.js';
import type { LoopLog } from './loop.js';

/**
 * Container logs (SHP-T-15.3; SHP-ADR-011, SHP-REQ-189, SHP-REQ-190). The agent reads a
 * container's logs through the Docker port (read-only dockerode, demultiplexed, with timestamps),
 * redacts them on the host, and posts them to the server in ordered chunks. Any container the
 * Engine knows may be read, whatever its tier.
 *
 * Redaction happens here, before a line leaves the host: every env-file value of the manifest or
 * stack whose compose project the container belongs to, and every one of the container's own Env
 * values longer than eight characters, becomes `[redacted]`. A host whose env files or manifests
 * cannot be read refuses the read rather than sending lines it could not redact.
 *
 * Bounded every way: the tail (at most 2000 lines, by the job's schema), a follow window of at
 * most five minutes (a job with `follow: false` is a tail only, whatever `followSeconds` says),
 * 2 MB of text, and the server's `continue: false` when the viewer has gone. Log text is never
 * written to disk or to the agent's own log — only IDs and counts are logged.
 */

export function logsChunkPath(logsId: string): string {
  return `/api/agent/logs/${logsId}/chunks`;
}

/** Text sent per read, at most (SHP-REQ-189). */
export const LOGS_MAX_BYTES = 2 * 1024 * 1024;
/** Log reads at once; one more is refused, not queued. */
export const LOGS_MAX_STREAMS = 3;
/** A chunk is sent at this many lines… */
export const LOGS_CHUNK_LINES = 500;
/** …or this often, whichever comes first. */
export const LOGS_FLUSH_MS = 500;
/** `LogLine.text` is capped at 16 KiB. */
const MAX_LINE_CHARS = 16_384;

export interface LogsTimers {
  /** Calls `fn` once after `ms`; returns a cancel. */
  after(ms: number, fn: () => void): () => void;
  /** Calls `fn` every `ms`; returns a cancel. */
  every(ms: number, fn: () => void): () => void;
}

const realTimers: LogsTimers = {
  after(ms, fn) {
    const t = setTimeout(fn, ms);
    t.unref();
    return () => {
      clearTimeout(t);
    };
  },
  every(ms, fn) {
    const t = setInterval(fn, ms);
    t.unref();
    return () => {
      clearInterval(t);
    };
  },
};

export interface LogsRunnerOptions {
  client: AgentClient;
  docker: DockerPort;
  fs: FsPort;
  apps: () => Promise<LoadedManifests>;
  stacks: () => Promise<LoadedStacks>;
  /** Never given a line of log text. */
  log: LoopLog;
  maxStreams?: number;
  maxBytes?: number;
  chunkLines?: number;
  flushMs?: number;
  timers?: LogsTimers;
}

export interface LogsRunner {
  /** Streams the job in the background; the loop keeps polling. */
  offer(job: LogsJob): void;
  /** Streams the job (or refuses it when too many are open) and resolves when its last chunk is sent. */
  run(job: LogsJob): Promise<void>;
  active(): number;
}

type StopReason = 'end' | 'window' | 'cap' | 'server' | 'error' | 'send-failed';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createLogsRunner(opts: LogsRunnerOptions): LogsRunner {
  const { client, docker, fs, log } = opts;
  const maxStreams = opts.maxStreams ?? LOGS_MAX_STREAMS;
  const maxBytes = opts.maxBytes ?? LOGS_MAX_BYTES;
  const chunkLines = opts.chunkLines ?? LOGS_CHUNK_LINES;
  const flushMs = opts.flushMs ?? LOGS_FLUSH_MS;
  const timers = opts.timers ?? realTimers;
  let active = 0;

  /** The redactor for this container, or the refusal to send instead of any line. */
  const redactorFor = async (job: LogsJob): Promise<((text: string) => string) | Refusal> => {
    const inspect = docker.inspectEnv?.bind(docker);
    if (inspect === undefined || docker.containerLogs === undefined) {
      return refusal('invalid_request', 'This agent cannot read container logs.', 'Upgrade the agent (docs/runbooks/upgrade-agent.md).');
    }
    let facts;
    try {
      facts = await inspect(job.containerId);
    } catch (err) {
      return refusal('action_failed', `The Docker Engine could not inspect the container: ${message(err)}`, 'Check the Docker Engine on the host, then try again.');
    }
    if (facts === null) return refusal('unknown_container', `The Docker Engine on this host has no container ${job.containerId.slice(0, 12)}.`);

    let envFiles: string[] | undefined;
    const project = facts.composeProject;
    if (project !== null) {
      try {
        const app = [...(await opts.apps()).values()].find((m) => m.manifest.compose.project === project);
        const stack = app === undefined ? [...(await opts.stacks()).values()].find((s) => s.manifest.compose.project === project) : undefined;
        envFiles = app?.manifest.envFiles ?? stack?.manifest.envFiles;
      } catch (err) {
        // Which env files apply cannot be known, so nothing is sent (SHP-REQ-190).
        return err instanceof ManifestLoadError ? err.toRefusal() : refusal('manifest_invalid', `The host's manifests could not be read: ${message(err)}`);
      }
    }
    let secrets: Map<string, string>;
    try {
      secrets = await loadSecrets(fs, envFiles);
    } catch (err) {
      return refusal('manifest_invalid', `The container's env file could not be read, so its logs cannot be redacted: ${message(err)}`);
    }
    return createRedactor(redactionValues(secrets, facts.envValues));
  };

  const stream = async (job: LogsJob): Promise<void> => {
    const ids = { logsId: job.logsId, container: job.containerId.slice(0, 12) };
    let seq = 0;
    const send = async (lines: LogLine[], done: boolean, error?: Refusal): Promise<boolean> => {
      const chunk: LogsChunk = { logsId: job.logsId, seq: seq++, lines, done, ...(error === undefined ? {} : { error }) };
      const ack = LogsChunkAck.safeParse(await client.request('POST', logsChunkPath(job.logsId), chunk));
      // Only an explicit `continue: false` stops a stream; the server owns that decision.
      return !ack.success || ack.data.continue;
    };
    const refuse = async (why: Refusal): Promise<void> => {
      log.warn({ ...ids, refusal: why.code }, 'log read refused');
      await send([], true, why).catch((err: unknown) => {
        log.warn({ ...ids, err: message(err) }, 'could not send the log refusal');
      });
    };

    const redactor = await redactorFor(job);
    if (typeof redactor !== 'function') {
      await refuse(redactor);
      return;
    }
    const readLogs = docker.containerLogs?.bind(docker);
    if (readLogs === undefined) return;

    // `follow: false` is a tail only, whatever `followSeconds` says; a follow is capped at five minutes.
    const followSeconds = Math.min(job.followSeconds, LOGS_MAX_FOLLOW_SECONDS);
    const follow = job.follow && followSeconds > 0;
    const abort = new AbortController();
    // An object, not a `let`: the timers and the send chain set it from callbacks.
    const ended: { reason: StopReason } = { reason: 'end' };
    const stop = (why: StopReason): void => {
      if (abort.signal.aborted) return;
      ended.reason = why;
      abort.abort();
    };

    let buffer: LogLine[] = [];
    let chain: Promise<void> = Promise.resolve();
    let lines = 0;
    let bytes = 0;
    let readError: string | undefined;

    /** Sends what is buffered, in order after every earlier chunk. */
    const flush = (): Promise<void> => {
      if (buffer.length === 0) return chain;
      const batch = buffer;
      buffer = [];
      chain = chain.then(async () => {
        if (ended.reason === 'server' || ended.reason === 'send-failed') return;
        try {
          if (!(await send(batch, false))) stop('server');
        } catch (err) {
          log.warn({ ...ids, err: message(err) }, 'could not send a log chunk; stopping the read');
          stop('send-failed');
        }
      });
      return chain;
    };

    const cancelWindow = follow ? timers.after(followSeconds * 1000, () => { stop('window'); }) : () => undefined;
    const cancelTick = timers.every(flushMs, () => void flush());
    try {
      const options = { tail: job.tail, follow, signal: abort.signal, ...(job.since === undefined ? {} : { since: job.since }) };
      for await (const line of readLogs(job.containerId, options)) {
        if (abort.signal.aborted) break;
        // Redacted before it is cut, so a cut can never leave the start of a secret behind.
        const text = redactor(line.text).slice(0, MAX_LINE_CHARS);
        const size = Buffer.byteLength(text, 'utf8');
        if (bytes + size > maxBytes) {
          stop('cap');
          break;
        }
        bytes += size;
        lines += 1;
        buffer.push({ at: line.at, stream: line.stream, text });
        if (buffer.length >= chunkLines) await flush();
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        ended.reason = 'error';
        readError = message(err);
      }
    } finally {
      cancelWindow();
      cancelTick();
    }
    await chain;

    if (ended.reason !== 'server' && ended.reason !== 'send-failed') {
      const error =
        readError === undefined ? undefined : refusal('action_failed', 'The Docker Engine ended the log stream with an error.', 'Open the logs again; if it persists, check the Docker Engine on the host.');
      const last = buffer;
      buffer = [];
      try {
        await send(last, true, error);
      } catch (err) {
        log.warn({ ...ids, err: message(err) }, 'could not send the last log chunk');
      }
    }
    // Counts and IDs only, never a line (SHP-REQ-190).
    log.info({ ...ids, lines, bytes, chunks: seq, reason: ended.reason, ...(readError === undefined ? {} : { err: readError }) }, 'log read finished');
  };

  const run = async (job: LogsJob): Promise<void> => {
    // Counted before the first await, so a burst of reads cannot all slip under the limit.
    if (active >= maxStreams) {
      const chunk: LogsChunk = {
        logsId: job.logsId,
        seq: 0,
        lines: [],
        done: true,
        error: refusal('conflict', `This agent is already streaming ${String(maxStreams)} logs.`, 'Close another log view, then open this one again.'),
      };
      await client.request('POST', logsChunkPath(job.logsId), chunk).catch((err: unknown) => {
        log.warn({ logsId: job.logsId, err: message(err) }, 'could not send the log refusal');
      });
      return;
    }
    active += 1;
    try {
      await stream(job);
    } catch (err) {
      log.error({ logsId: job.logsId, err: message(err) }, 'log runner failed');
    } finally {
      active -= 1;
    }
  };

  return {
    offer: (job) => void run(job),
    run,
    active: () => active,
  };
}
