import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for the Shipyard server's agent API (`/api/agent/poll|progress|steps|result`), for
 * e2e tests that run the real agent loop. It hands out queued targets, records everything the
 * agent sends, and can be taken down and brought back on the same port, the way a broken
 * self-deployed server disappears and a fixed one returns.
 *
 * Signatures are not verified (the server's own tests do that); each request must carry the four
 * `x-shipyard-*` headers, and `keys` records the fingerprints seen.
 */

export interface ReceivedRequest {
  path: string;
  body: unknown;
  at: number;
}

export interface FakeControlPlane {
  readonly url: string;
  readonly port: number;
  /** Every request received, in order. */
  readonly received: ReceivedRequest[];
  readonly keys: Set<string>;
  /** Hands `target` to the next poll. */
  enqueue(target: object): void;
  /** Called for each progress body before it is answered (e.g. to take the plane down). */
  onProgress: ((body: Record<string, unknown>) => void) | null;
  readonly up: boolean;
  /** Refuses every connection from now on: the listener closes and open sockets are dropped. */
  down(): Promise<void>;
  /** Listens again on the same port. */
  restart(): Promise<void>;
  stop(): Promise<void>;
}

const SIG_HEADERS = ['x-shipyard-key', 'x-shipyard-timestamp', 'x-shipyard-nonce', 'x-shipyard-signature'];

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text.length === 0 ? null : (JSON.parse(text) as unknown));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function startFakeControlPlane(options: { idlePollMs?: number } = {}): Promise<FakeControlPlane> {
  const idlePollMs = options.idlePollMs ?? 200;
  const received: ReceivedRequest[] = [];
  const keys = new Set<string>();
  const queue: object[] = [];
  let server: Server | null = null;
  let isUp = false;
  let port = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isUp) {
      req.socket.destroy();
      return;
    }
    const path = (req.url ?? '').split('?')[0] ?? '';
    const missing = SIG_HEADERS.filter((h) => typeof req.headers[h] !== 'string');
    if (req.method !== 'POST' || missing.length > 0) {
      send(res, 401, { error: { code: 'unauthorized', message: `unsigned request (missing ${missing.join(', ')})` } });
      return;
    }
    keys.add(String(req.headers['x-shipyard-key']));
    const body = await readBody(req);
    received.push({ path, body, at: Date.now() });

    switch (path) {
      case '/api/agent/poll': {
        const next = queue.shift();
        if (next !== undefined) {
          send(res, 200, { target: next });
          return;
        }
        // A short hold, so an idle agent does not spin.
        await new Promise((r) => setTimeout(r, idlePollMs));
        send(res, 200, { target: null });
        return;
      }
      case '/api/agent/progress':
        plane.onProgress?.(body as Record<string, unknown>);
        // Read through the getter: the hook above may just have taken the plane down.
        if (!plane.up) {
          req.socket.destroy();
          return;
        }
        send(res, 200, { ok: true });
        return;
      case '/api/agent/steps':
      case '/api/agent/result':
        send(res, 200, { ok: true });
        return;
      default:
        send(res, 404, { error: { code: 'not_found', message: path } });
    }
  };

  const listen = (onPort: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const s = createServer((req, res) => {
        handle(req, res).catch(() => {
          if (!res.headersSent) send(res, 500, { error: { code: 'internal', message: 'fake control plane failed' } });
        });
      });
      s.once('error', reject);
      s.listen(onPort, '127.0.0.1', () => {
        server = s;
        port = (s.address() as AddressInfo).port;
        isUp = true;
        resolve();
      });
    });

  const close = (): Promise<void> =>
    new Promise((resolve) => {
      isUp = false;
      const s = server;
      server = null;
      if (s === null) {
        resolve();
        return;
      }
      s.close(() => {
        resolve();
      });
      s.closeAllConnections();
    });

  await listen(0);

  const plane: FakeControlPlane = {
    get url() {
      return `http://127.0.0.1:${String(port)}`;
    },
    get port() {
      return port;
    },
    received,
    keys,
    enqueue: (target) => queue.push(target),
    onProgress: null,
    get up() {
      return isUp;
    },
    down: close,
    restart: () => listen(port),
    stop: close,
  };
  return plane;
}
