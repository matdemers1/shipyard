import { vi } from 'vitest';
import type { Me } from '../src/lib/api';

/** A route's answer: a status and a JSON body. */
export interface Reply {
  status: number;
  body?: unknown;
}

export type Handler = (init: RequestInit | undefined) => Reply;

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

/**
 * Replaces `fetch` with a table keyed by `METHOD /path`. A handler may be a fixed reply, a function,
 * or a list answered in order (the last one repeats). Unrouted requests are a test failure.
 */
export function mockFetch(routes: Record<string, Reply | Handler | Reply[]>): Call[] {
  const calls: Call[] = [];
  const counters = new Map<string, number>();
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, 'http://localhost').pathname;
    const method = init?.method ?? 'GET';
    const key = `${method} ${path}`;
    calls.push({ method, path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    // A signed-out console asks whether first-run setup is open; unless a test says otherwise, the
    // server already has accounts.
    const route = routes[key] ?? (key === 'GET /api/setup' ? SETUP_CLOSED : undefined);
    if (route === undefined) throw new Error(`unexpected request: ${key}`);
    let reply: Reply;
    if (typeof route === 'function') reply = route(init);
    else if (Array.isArray(route)) {
      const n = counters.get(key) ?? 0;
      counters.set(key, n + 1);
      const picked = route[Math.min(n, route.length - 1)];
      if (picked === undefined) throw new Error(`no reply for ${key}`);
      reply = picked;
    } else reply = route;
    return Promise.resolve(
      new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

export const SETUP_CLOSED: Reply = { status: 200, body: { available: false } };
export const SETUP_OPEN: Reply = { status: 200, body: { available: true } };

export const NOT_SIGNED_IN: Reply = {
  status: 401,
  body: { error: { code: 'unauthenticated', gate: 'none', message: 'You are not signed in.', fix: 'Sign in and retry.' } },
};

export function meReply(role: Me['role'], overrides: Partial<Me> = {}): Reply {
  return {
    status: 200,
    body: {
      id: 'u1',
      email: 'matt@example.com',
      displayName: 'Matt',
      role,
      identities: [],
      ...overrides,
    } satisfies Me,
  };
}
