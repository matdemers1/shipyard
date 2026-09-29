import { Router } from 'express';
import type { ServiceDeps } from '../deps.js';
import { readableBuild } from './routes.js';
import { getBuild, getBuildLogs, isTerminalBuild, type BuildDetail } from './service.js';

/**
 * Live build progress (SHP-T-7.4). Mounted at `/api/builds` before the builds router.
 *
 * `GET /:id/events` — Server-Sent Events: `build` (the full detail, stages included) and `logs`
 * (every chunk so far) at once; on each `build:<id>` publish, `build` again if it changed and
 * `logs` with only the new chunks; a `: ping` comment when idle; on a terminal state the final
 * `build`, `end`, and the stream closes. Every event's `id` is the last log id sent, so a
 * reconnect with `Last-Event-ID` resumes the log where it stopped and loses nothing.
 */

export interface BuildEventsOptions {
  /** How long an idle stream waits before a keep-alive comment. */
  pingMs?: number;
}

const DEFAULT_PING_MS = 15_000;

export function buildEventsRouter(deps: ServiceDeps, options: BuildEventsOptions = {}): Router {
  const { db, bus, logger } = deps;
  const pingMs = options.pingMs ?? DEFAULT_PING_MS;
  const router = Router();

  router.get('/:id/events', async (req, res) => {
    // Listen for the client going away before the first await, so no armed waiter is left behind.
    let closed = false;
    const isClosed = (): boolean => closed;
    let round: AbortController | null = null;
    const onClose = (): void => {
      closed = true;
      round?.abort();
    };
    res.on('close', onClose);

    const first = await readableBuild(db, req, res);
    if (first === null || isClosed()) {
      res.off('close', onClose);
      return;
    }
    const buildId = first.buildId;
    const topic = `build:${buildId}` as const;

    const lastEventId = req.headers['last-event-id'];
    let lastLogId = typeof lastEventId === 'string' && /^\d{1,19}$/.test(lastEventId) ? BigInt(lastEventId) : 0n;

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (event: string, data: unknown): void => {
      res.write(`id: ${lastLogId.toString()}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let lastBuild = '';
    /** Sends what changed since the last send; returns the build read. */
    const push = async (known?: BuildDetail): Promise<BuildDetail | null> => {
      const build = known ?? (await getBuild(db, buildId));
      const logs = await getBuildLogs(db, buildId, { afterId: lastLogId });
      if (isClosed() || build === null) return build;
      const buildJson = JSON.stringify(build);
      if (buildJson !== lastBuild) {
        lastBuild = buildJson;
        send('build', build);
      }
      const newest = logs[logs.length - 1];
      if (newest !== undefined) {
        lastLogId = BigInt(newest.id);
        send('logs', { logs });
      } else if (known !== undefined) {
        // The first round always says where the log stands, even when it is empty.
        send('logs', { logs: [] });
      }
      return build;
    };

    try {
      let known: BuildDetail | undefined = first;
      while (!isClosed()) {
        // Armed before the read, so a publish between the read and the wait is not lost.
        const current = new AbortController();
        round = current;
        const woken = bus.wait(topic, pingMs, current.signal);
        let published = false;
        try {
          const build = await push(known);
          known = undefined;
          if (isClosed() || build === null || isTerminalBuild(build.state)) {
            if (!isClosed()) {
              send('end', { state: build?.state ?? null });
              res.end();
            }
            return;
          }
          published = await woken;
        } finally {
          current.abort();
          await woken;
          round = null;
        }
        if (!isClosed() && !published) res.write(': ping\n\n');
      }
    } catch (err) {
      logger.error({ err, buildId }, 'build event stream failed');
      if (!res.writableEnded) res.end();
    } finally {
      res.off('close', onClose);
    }
  });

  return router;
}
