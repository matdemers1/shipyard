import { randomBytes } from 'node:crypto';
import { createAuthClient, type AuthClient } from '@d3cloudio/auth-client';
import type { Logger } from 'pino';
import type { Config } from '../config.js';

/**
 * Sign in with D3 Auth (SHP-REQ-001), behind an interface so the routes never touch the SDK and
 * tests inject a fake. The SDK checks PKCE, state, nonce and the issuer; this layer checks *which
 * browser* started the sign-in, which only Shipyard knows.
 */
export interface OidcClient {
  readonly issuer: string;
  /** Starts a sign-in. `linkToUserId` makes it a link for that already-signed-in account. */
  beginSignIn(linkToUserId?: string): Promise<{ url: string; tx: string }>;
  /** Throws {@link OidcError} for an unknown or expired `tx`, a state mismatch, or an SDK refusal. */
  completeSignIn(callbackUrl: URL, tx: string, state: string): Promise<CompletedSignIn>;
}

export interface CompletedSignIn {
  iss: string;
  sub: string;
  email?: string;
  name?: string;
  linkToUserId?: string;
}

export class OidcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OidcError';
  }
}

/** Ten minutes is longer than any real sign-in takes. */
export const OIDC_TX_TTL_MS = 10 * 60 * 1000;
/** Discovery at boot gives up after this, so an issuer that black-holes packets cannot stall startup. */
const DISCOVERY_TIMEOUT_MS = 10_000;

interface Pending {
  verifier: string;
  state: string;
  nonce: string;
  expiresAt: number;
  linkToUserId?: string;
}

/** Keeps pending sign-ins keyed by a random `tx`; shared by the real client and usable by fakes. */
export class PendingSignIns<T extends { expiresAt: number }> {
  private readonly pending = new Map<string, T>();

  put(value: T): string {
    this.sweep();
    const tx = randomBytes(32).toString('base64url');
    this.pending.set(tx, value);
    return tx;
  }

  /** Single use: the entry is removed whether or not it is still valid. */
  take(tx: string, now: number = Date.now()): T {
    const value = this.pending.get(tx);
    this.pending.delete(tx);
    if (value === undefined) throw new OidcError('No sign-in is in progress for this browser.');
    if (value.expiresAt <= now) throw new OidcError('The sign-in took too long.');
    return value;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, value] of this.pending) if (value.expiresAt <= now) this.pending.delete(key);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} timed out after ${ms} ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Discovers the provider and builds a client, or returns `null` when OIDC is not configured or the
 * issuer is unreachable. Never throws: a provider that is down is a Shipyard with one login path,
 * not a Shipyard that will not start.
 */
export async function createOidcClient(config: Config, logger?: Logger): Promise<OidcClient | null> {
  if (!config.oidcConfigured) return null;
  const issuer = config.D3AUTH_ISSUER ?? '';
  const redirectUri = new URL('/api/auth/oidc/callback', config.PUBLIC_URL).toString();

  let client: AuthClient;
  try {
    client = await withTimeout(
      createAuthClient({
        issuer,
        clientId: config.D3AUTH_CLIENT_ID ?? '',
        ...(config.D3AUTH_CLIENT_SECRET !== undefined ? { clientSecret: config.D3AUTH_CLIENT_SECRET } : {}),
        redirectUri,
        scope: 'openid profile email d3:roles',
        ssoMode: 'optional',
        ...(issuer.startsWith('http://') ? { allowInsecureHttp: true } : {}),
      }),
      DISCOVERY_TIMEOUT_MS,
      'D3 Auth discovery',
    );
  } catch (error) {
    logger?.warn(
      { issuer, err: error instanceof Error ? error.message : String(error) },
      'D3 Auth discovery failed; Sign in with D3 Auth is unavailable, password login is unaffected',
    );
    return null;
  }

  const pending = new PendingSignIns<Pending>();

  return {
    issuer,

    async beginSignIn(linkToUserId) {
      const start = await client.beginSignIn();
      const tx = pending.put({
        verifier: start.verifier,
        state: start.state,
        nonce: start.nonce,
        expiresAt: Date.now() + OIDC_TX_TTL_MS,
        ...(linkToUserId !== undefined ? { linkToUserId } : {}),
      });
      return { url: start.url, tx };
    },

    async completeSignIn(callbackUrl, tx, state) {
      const started = pending.take(tx);
      if (started.state !== state) throw new OidcError('The sign-in state did not match.');

      let session;
      try {
        session = await client.completeSignIn(callbackUrl, {
          verifier: started.verifier,
          state: started.state,
          nonce: started.nonce,
        });
      } catch (error) {
        throw new OidcError(error instanceof Error ? error.message : String(error));
      }

      const { identity } = session;
      const email = typeof identity.claims['email'] === 'string' ? identity.claims['email'] : undefined;
      const name = typeof identity.claims['name'] === 'string' ? identity.claims['name'] : undefined;
      return {
        iss: identity.iss,
        sub: identity.sub,
        ...(email !== undefined ? { email } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(started.linkToUserId !== undefined ? { linkToUserId: started.linkToUserId } : {}),
      };
    },
  };
}
