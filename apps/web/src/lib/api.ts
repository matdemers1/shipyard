import type { ErrorCode, Gate, LoginRequest, Refusal, TotpRequest } from '@shipyard/schema';

/**
 * The console's one way to talk to the server.
 *
 * Same origin, the `shipyard_session` cookie (HttpOnly, so the browser holds it and this code never
 * sees it), JSON both ways. Every refusal the server sends is `{ error: { code, gate, message, fix } }`
 * and becomes a {@link RefusalError}, so a screen can always show what happened *and* what to do.
 */

export type Role = 'admin' | 'operator' | 'deployer' | 'viewer';

/** `GET /api/auth/me`. */
export interface Me {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  identities: { issuer: string }[];
}

/** `GET /api/auth/methods`: which ways in this server offers. */
export interface AuthMethods {
  password: boolean;
  d3auth: boolean;
}

/** A refusal from the server, carrying the catalogue's fields and the HTTP status. */
export class RefusalError extends Error {
  readonly code: ErrorCode;
  readonly gate: Gate;
  readonly fix: string;
  readonly status: number;

  constructor(refusal: Refusal, status: number) {
    super(refusal.message);
    this.name = 'RefusalError';
    this.code = refusal.code;
    this.gate = refusal.gate;
    this.fix = refusal.fix;
    this.status = status;
  }
}

/**
 * The server did not answer, or answered with something that is not a refusal. Said as a refusal
 * would be, so the screen that shows it has a next step too.
 */
export function unreachableRefusal(status?: number): RefusalError {
  return new RefusalError(
    {
      code: 'invalid_request',
      gate: 'none',
      message:
        status === undefined
          ? 'Shipyard is not answering.'
          : `Shipyard answered with an unexpected response (HTTP ${status}).`,
      fix: 'Check that the server is running and reachable, then try again.',
    },
    status ?? 0,
  );
}

let onSessionGone: (() => void) | null = null;

/** The auth provider registers here: a 401 on any session-bearing call means the session is gone. */
export function setSessionGoneHandler(handler: (() => void) | null): void {
  onSessionGone = handler;
}

function isRefusalBody(body: unknown): body is { error: Refusal } {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false;
  const error = body.error;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { message?: unknown }).message === 'string' &&
    typeof (error as { fix?: unknown }).fix === 'string'
  );
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /**
   * `false` for the sign-in steps themselves: their 401 means "wrong password", not "your session
   * ended", and must not bounce the person back to the screen they are already on.
   */
  sessionBearing?: boolean;
  signal?: AbortSignal;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, sessionBearing = true, signal } = options;
  const init: RequestInit = {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal !== undefined ? { signal } : {}),
  };

  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw unreachableRefusal();
  }

  let parsed: unknown = null;
  const text = await res.text();
  if (text !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    if (res.status === 401 && sessionBearing && onSessionGone !== null) onSessionGone();
    if (isRefusalBody(parsed)) throw new RefusalError(parsed.error, res.status);
    throw unreachableRefusal(res.status);
  }
  return parsed as T;
}

// ── Auth ────────────────────────────────────────────────────────────────

export const auth = {
  methods: (): Promise<AuthMethods> => request<AuthMethods>('/api/auth/methods', { sessionBearing: false }),
  /** `null` when nobody is signed in: a 401 here is an answer, not an error. */
  me: async (): Promise<Me | null> => {
    try {
      return await request<Me>('/api/auth/me', { sessionBearing: false });
    } catch (error) {
      if (error instanceof RefusalError && error.status === 401) return null;
      throw error;
    }
  },
  login: (body: LoginRequest): Promise<{ next: 'totp' }> =>
    request('/api/auth/login', { method: 'POST', body, sessionBearing: false }),
  totp: (body: TotpRequest): Promise<Pick<Me, 'id' | 'email' | 'displayName' | 'role'>> =>
    request('/api/auth/totp', { method: 'POST', body, sessionBearing: false }),
  logout: (): Promise<{ ok: true }> => request('/api/auth/logout', { method: 'POST', sessionBearing: false }),
};

/** A browser navigation, not a fetch: the server answers with a 302 to D3 Auth. */
export const OIDC_START_PATH = '/api/auth/oidc/start';
