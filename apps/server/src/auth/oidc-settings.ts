import type { D3AuthSource } from '@shipyard/schema';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { decryptSecret, deriveSettingsKey } from '../settings/crypto.js';
import { buildOidcClient, type OidcClient, type OidcParams } from './oidc.js';

/**
 * The live Sign in with D3 Auth client (SHP-REQ-110). Built at boot from server.env when any
 * `D3AUTH_*` variable is set (env wins, and the console shows it read-only), otherwise from the
 * `setting` row an admin saved in the console. A save calls {@link OidcSettings.load} again, so the
 * client is swapped without a restart; every route reads {@link OidcSettings.current} per request.
 *
 * Whatever happens here — a missing PUBLIC_URL, an unreadable secret, an issuer that does not
 * answer — the result is `current() === null`: no D3 Auth button, and password login untouched
 * (SHP-REQ-001). Nothing here throws on a bad configuration.
 */

export const D3AUTH_SETTING_KEY = 'd3auth';

/** The `setting.value` JSON for D3 Auth. `clientSecret` is sealed (settings/crypto.ts), never plaintext. */
export interface StoredD3Auth {
  issuer: string;
  clientId: string;
  clientSecret: string | null;
}

export function parseStoredD3Auth(value: unknown): StoredD3Auth | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['issuer'] !== 'string' || typeof v['clientId'] !== 'string') return null;
  const secret = v['clientSecret'];
  return { issuer: v['issuer'], clientId: v['clientId'], clientSecret: typeof secret === 'string' ? secret : null };
}

/** Anything that yields the current client; `authRouter` takes one of these. */
export interface OidcSource {
  current(): OidcClient | null;
}

export type OidcBuilder = (params: OidcParams, logger?: Logger) => Promise<OidcClient | null>;

export interface OidcState {
  source: D3AuthSource;
  issuer: string | null;
  clientId: string | null;
  clientSecretSet: boolean;
  /** Discovery succeeded when the client was last built; null when nothing was attempted. */
  reachable: boolean | null;
  /** Why it is configured but unavailable, in a sentence. */
  problem: string | null;
  updatedAt: Date | null;
}

const NONE: OidcState = {
  source: 'none',
  issuer: null,
  clientId: null,
  clientSecretSet: false,
  reachable: null,
  problem: null,
  updatedAt: null,
};

/** True when server.env names any part of D3 Auth: then it owns the setting, and the console is read-only. */
export function envOwnsD3Auth(config: Config): boolean {
  return config.D3AUTH_ISSUER !== undefined || config.D3AUTH_CLIENT_ID !== undefined || config.D3AUTH_CLIENT_SECRET !== undefined;
}

const UNREACHABLE =
  'The issuer did not answer OpenID discovery, so the D3 Auth button is off. Use Test to see why; save again or restart once it answers.';

export interface OidcSettingsDeps {
  db: Db;
  logger: Logger;
  config: Config;
  /** Tests inject a fake; production uses the D3 Auth SDK's discovery. */
  build?: OidcBuilder;
}

export class OidcSettings implements OidcSource {
  private client: OidcClient | null;
  private snapshot: OidcState;
  private generation = 0;
  private readonly build: OidcBuilder;

  /** `initial` is served until the first {@link load}: tests hand in a fixed client this way. */
  constructor(
    private readonly deps: OidcSettingsDeps,
    initial: OidcClient | null = null,
  ) {
    this.client = initial;
    this.snapshot = initial === null ? NONE : { ...NONE, issuer: initial.issuer, reachable: true };
    this.build = deps.build ?? buildOidcClient;
  }

  current(): OidcClient | null {
    return this.client;
  }

  state(): OidcState {
    return this.snapshot;
  }

  /** (Re)builds the client from server.env or the stored setting. Never throws for a bad configuration. */
  async load(): Promise<void> {
    const generation = ++this.generation;
    let next: { client: OidcClient | null; state: OidcState };
    try {
      next = envOwnsD3Auth(this.deps.config) ? await this.fromEnv() : await this.fromSettings();
    } catch (error) {
      // A database that is not there yet (or not migrated) must not stop the server starting.
      this.deps.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'could not read the D3 Auth setting; Sign in with D3 Auth is unavailable, password login is unaffected',
      );
      next = { client: null, state: { ...NONE, problem: 'The stored D3 Auth setting could not be read.' } };
    }
    const { client, state } = next;
    // Two saves in quick succession: the later one wins, whichever discovery answers first.
    if (generation !== this.generation) return;
    this.client = client;
    this.snapshot = state;
  }

  private async fromEnv(): Promise<{ client: OidcClient | null; state: OidcState }> {
    const { config, logger } = this.deps;
    const base: OidcState = {
      ...NONE,
      source: 'env',
      issuer: config.D3AUTH_ISSUER ?? null,
      clientId: config.D3AUTH_CLIENT_ID ?? null,
      clientSecretSet: config.D3AUTH_CLIENT_SECRET !== undefined,
    };
    if (!config.oidcConfigured) {
      return {
        client: null,
        state: { ...base, problem: 'server.env needs D3AUTH_ISSUER, D3AUTH_CLIENT_ID and PUBLIC_URL all set.' },
      };
    }
    const client = await this.build(
      {
        issuer: config.D3AUTH_ISSUER ?? '',
        clientId: config.D3AUTH_CLIENT_ID ?? '',
        ...(config.D3AUTH_CLIENT_SECRET !== undefined ? { clientSecret: config.D3AUTH_CLIENT_SECRET } : {}),
        publicUrl: config.PUBLIC_URL ?? '',
      },
      logger,
    );
    return { client, state: { ...base, reachable: client !== null, problem: client === null ? UNREACHABLE : null } };
  }

  private async fromSettings(): Promise<{ client: OidcClient | null; state: OidcState }> {
    const { db, config, logger } = this.deps;
    const row = await db.setting.findUnique({ where: { key: D3AUTH_SETTING_KEY } });
    const stored = row === null ? null : parseStoredD3Auth(row.value);
    if (row === null || stored === null) return { client: null, state: NONE };

    const base: OidcState = {
      ...NONE,
      source: 'settings',
      issuer: stored.issuer,
      clientId: stored.clientId,
      clientSecretSet: stored.clientSecret !== null,
      updatedAt: row.updatedAt,
    };
    if (config.PUBLIC_URL === undefined) {
      return { client: null, state: { ...base, problem: 'PUBLIC_URL is unset in server.env, so there is no redirect URI.' } };
    }

    let clientSecret: string | undefined;
    if (stored.clientSecret !== null) {
      if (config.SESSION_SECRET === undefined) {
        return {
          client: null,
          state: { ...base, problem: 'The stored client secret cannot be read: SESSION_SECRET is unset in server.env.' },
        };
      }
      try {
        clientSecret = decryptSecret(stored.clientSecret, deriveSettingsKey(config.SESSION_SECRET));
      } catch (error) {
        const problem = error instanceof Error ? error.message : 'The stored client secret cannot be read.';
        logger.warn('the stored D3 Auth client secret cannot be decrypted; Sign in with D3 Auth is unavailable');
        return { client: null, state: { ...base, problem } };
      }
    }

    const client = await this.build(
      {
        issuer: stored.issuer,
        clientId: stored.clientId,
        ...(clientSecret !== undefined ? { clientSecret } : {}),
        publicUrl: config.PUBLIC_URL,
      },
      logger,
    );
    return { client, state: { ...base, reachable: client !== null, problem: client === null ? UNREACHABLE : null } };
  }
}
