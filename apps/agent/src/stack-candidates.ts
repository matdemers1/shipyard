import type { AgentStackService, Digest, StackManifest } from '@shipyard/schema';
import { RegistryError, resolveTrack, stackRunningDigests, type DockerPort, type StackRegistryPort } from '@shipyard/sequence';

/**
 * Update candidates for adopted stacks (SHP-ADR-010, SHP-REQ-194): on the report interval, each
 * tracked service's track is resolved to a digest, and a candidate is reported when it differs
 * from the digest the service runs.
 *
 * The registry is asked rarely and never on the heartbeat's critical path:
 *
 * - a service is re-checked at most every `recheckMs` (30 minutes), sooner once `invalidate` says
 *   an update or rollback of its stack just ran, and at once when its image or track changes;
 * - a failed check is retried after `errorRetryMs`, and a 429 after whatever `Retry-After` asked
 *   for (never sooner than `errorRetryMs`) — the failure is the service's `error`, not a crash;
 * - a report waits at most `deadlineMs` for checks it started; one still running finishes in the
 *   background and the next report carries it, with the last known answer reported meanwhile.
 *
 * The running digest is read from the Engine on every report: it is local and cheap.
 */

export const CANDIDATE_RECHECK_MS = 30 * 60_000;
export const CANDIDATE_ERROR_RETRY_MS = 5 * 60_000;
/** Well inside the report's own inventory deadline: the heartbeat must still go. */
export const CANDIDATE_DEADLINE_MS = 8_000;
const MAX_ERROR = 500;

type DigestStack = Extract<StackManifest, { updates: 'digest' }>;

interface Entry {
  /** The image and track this answer is for; a manifest edit makes it stale. */
  key: string;
  resolved: { tag: string; digest: Digest } | null;
  error: string | null;
  checkedAt: string | null;
  nextCheckAt: number;
  inFlight: Promise<void> | null;
}

export interface CandidateCheckerOptions {
  registry: StackRegistryPort;
  docker: DockerPort;
  now?: () => number;
  recheckMs?: number;
  errorRetryMs?: number;
  deadlineMs?: number;
  log?: { warn(obj: object, msg?: string): void };
}

export interface CandidateChecker {
  /** Each tracked service's running digest and candidate, for a digest-updated stack's report entry. */
  services(stack: StackManifest): Promise<Record<string, AgentStackService> | undefined>;
  /** Re-check the stack's services on the next report (after an update or rollback of it). */
  invalidate(stack: string): void;
}

function clip(text: string): string {
  return text.length <= MAX_ERROR ? text : `${text.slice(0, MAX_ERROR - 1)}…`;
}

export function createCandidateChecker(opts: CandidateCheckerOptions): CandidateChecker {
  const now = opts.now ?? Date.now;
  const recheckMs = opts.recheckMs ?? CANDIDATE_RECHECK_MS;
  const errorRetryMs = opts.errorRetryMs ?? CANDIDATE_ERROR_RETRY_MS;
  const deadlineMs = opts.deadlineMs ?? CANDIDATE_DEADLINE_MS;
  const cache = new Map<string, Entry>();

  const check = async (entry: Entry, stack: DigestStack, service: string): Promise<void> => {
    const tracked = stack.services[service];
    if (tracked === undefined) return;
    try {
      const resolution = await resolveTrack(opts.registry, tracked.image, tracked.track);
      entry.resolved = resolution.kind === 'resolved' ? { tag: resolution.tag, digest: resolution.digest } : null;
      entry.error = resolution.kind === 'missing' ? clip(resolution.why) : null;
      entry.nextCheckAt = now() + recheckMs;
    } catch (err) {
      // Kept: the last answer stays reported beside the error; an update re-resolves anyway.
      const limited = err instanceof RegistryError && err.kind === 'rate_limited';
      const wait = limited ? Math.max(err.retryAfterMs ?? recheckMs, errorRetryMs) : errorRetryMs;
      entry.error = clip(limited ? `${err.message}; trying again in ${String(Math.ceil(wait / 60_000))} min` : err instanceof Error ? err.message : String(err));
      entry.nextCheckAt = now() + wait;
      opts.log?.warn({ stack: stack.name, service, err: entry.error }, 'stack candidate check failed');
    }
    entry.checkedAt = new Date(now()).toISOString();
  };

  return {
    async services(stack) {
      if (stack.updates !== 'digest') return undefined;
      const pending: Promise<void>[] = [];
      const entries = new Map<string, Entry>();
      for (const [service, tracked] of Object.entries(stack.services)) {
        const id = `${stack.name}\u0000${service}`;
        const key = `${tracked.image}\u0000${JSON.stringify(tracked.track)}`;
        let entry = cache.get(id);
        if (entry === undefined || entry.key !== key) {
          entry = { key, resolved: null, error: null, checkedAt: null, nextCheckAt: 0, inFlight: null };
          cache.set(id, entry);
        }
        entries.set(service, entry);
        if (entry.inFlight === null && entry.nextCheckAt <= now()) {
          const e = entry;
          e.inFlight = check(e, stack, service).finally(() => {
            e.inFlight = null;
          });
        }
        if (entry.inFlight !== null) pending.push(entry.inFlight);
      }
      // Forget services no longer tracked.
      for (const id of cache.keys()) {
        const [name, service] = id.split('\u0000');
        if (name === stack.name && service !== undefined && !(service in stack.services)) cache.delete(id);
      }

      if (pending.length > 0) {
        let timer: NodeJS.Timeout | undefined;
        const deadline = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, deadlineMs);
          timer.unref();
        });
        await Promise.race([Promise.all(pending), deadline]);
        clearTimeout(timer);
      }

      let running: Record<string, Digest | null>;
      try {
        running = await stackRunningDigests(opts.docker, stack.compose, stack.services);
      } catch (err) {
        opts.log?.warn({ stack: stack.name, err: err instanceof Error ? err.message : String(err) }, 'could not read the stack’s running digests');
        running = {};
      }

      const out: Record<string, AgentStackService> = {};
      for (const [service, entry] of entries) {
        const current = running[service] ?? null;
        out[service] = {
          running: current,
          candidate: entry.resolved !== null && entry.resolved.digest !== current ? { ...entry.resolved } : null,
          checkedAt: entry.checkedAt,
          error: entry.error,
        };
      }
      return out;
    },

    invalidate(stack) {
      for (const [id, entry] of cache) if (id.startsWith(`${stack}\u0000`)) entry.nextCheckAt = 0;
    },
  };
}
