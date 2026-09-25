import { ErrorEnvelope, type Refusal } from '@shipyard/schema';
import { signHeaders, type AgentIdentity } from './identity.js';

/**
 * The agent's only way to talk to anything: outbound, signed HTTP requests to the server
 * (SHP-REQ-033, SHP-REQ-034). There is no listener in the agent, and this client never opens one.
 */

/** Thrown when the server answers non-2xx. `refusal` is the server's envelope when it sent one. */
export class AgentRequestError extends Error {
  readonly status: number;
  readonly refusal: Refusal | null;
  constructor(status: number, refusal: Refusal | null, method: string, path: string) {
    super(
      refusal === null
        ? `${method} ${path} failed with HTTP ${status}`
        : `${method} ${path} refused (${refusal.code}): ${refusal.message}`,
    );
    this.name = 'AgentRequestError';
    this.status = status;
    this.refusal = refusal;
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface AgentClientOptions {
  serverUrl: string;
  identity: AgentIdentity;
  fetch?: FetchLike;
  timeoutMs: number;
}

export interface AgentClient {
  request(method: string, path: string, body?: unknown): Promise<unknown>;
}

export function createAgentClient(opts: AgentClientOptions): AgentClient {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));

  return {
    async request(method: string, path: string, body?: unknown): Promise<unknown> {
      const verb = method.toUpperCase();
      const url = new URL(path, opts.serverUrl);
      const signedPath = `${url.pathname}${url.search}`;
      // Serialize once: the bytes signed are the bytes sent (SHP-D-064).
      const bytes = body === undefined ? new Uint8Array(0) : Buffer.from(JSON.stringify(body), 'utf8');
      const headers: Record<string, string> = {
        ...signHeaders(opts.identity, { method: verb, path: signedPath, body: bytes }),
        accept: 'application/json',
      };
      if (body !== undefined) headers['content-type'] = 'application/json';

      const res = await doFetch(url.toString(), {
        method: verb,
        headers,
        ...(body === undefined ? {} : { body: bytes }),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });

      const text = await res.text();
      let parsed: unknown = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text) as unknown;
        } catch (err) {
          if (res.ok) throw new Error(`${verb} ${signedPath} returned a non-JSON body`, { cause: err });
          parsed = null;
        }
      }
      if (!res.ok) {
        const envelope = ErrorEnvelope.safeParse(parsed);
        throw new AgentRequestError(res.status, envelope.success ? envelope.data.error : null, verb, signedPath);
      }
      return parsed;
    },
  };
}
