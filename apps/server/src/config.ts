import { z } from 'zod';

/** `.env.example` ships optional values blank; a blank string means "unset", not "set to ''". */
/** A blank numeric variable (`KEY=` in an env file) means "use the default", not zero. */
const blankAsUnset = (value: unknown): unknown => (typeof value === 'string' && value.trim() === '' ? undefined : value);

const optionalString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional(),
);

/**
 * Server configuration, parsed once at startup (SHP-T-0.4). A bad env fails fast with a clear
 * message rather than surfacing as a confusing runtime error later.
 */
export const Config = z
  .object({
    DATABASE_URL: z.string().min(1),
    PORT: z.preprocess(blankAsUnset, z.coerce.number().int().positive().default(3300)),
    PUBLIC_URL: optionalString,
    SESSION_SECRET: optionalString,
    LOG_LEVEL: z.string().min(1).default('info'),
    SHIPYARD_VERSION: z.string().min(1).default('dev'),
    // Sign in with D3 Auth (SHP-REQ-001). All optional: blank means app-native login only.
    D3AUTH_ISSUER: optionalString,
    D3AUTH_CLIENT_ID: optionalString,
    D3AUTH_CLIENT_SECRET: optionalString,
    // Optional: record deploys in Foreman through the outbox (SHP-D-033, SHP-D-062).
    FOREMAN_URL: optionalString,
    FOREMAN_TOKEN: optionalString,
    // Read-only PAT for changelogs on the console (the agent holds its own, SHP-D-043).
    GITHUB_TOKEN_SERVER: optionalString,
    // The built console (apps/web/dist), served at / with an SPA fallback. Unset in development.
    CONSOLE_DIST: optionalString,
    // How many reverse-proxy hops sit in front of the server (a tunnel is one). Unset means none,
    // so `req.ip` is the socket peer. Behind a proxy with this unset, every client shares the
    // proxy's address, and the per-IP sign-in throttle becomes one bucket anyone can fill.
    TRUST_PROXY_HOPS: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.coerce.number().int().min(0).max(5).optional(),
    ),
    // Alert email through an HTTP mail relay (D3 Auth's Worker on the D3 host). All optional:
    // unset means alerts are logged, never sent — a stranger's install still runs (SHP-T-6.4).
    MAIL_RELAY_URL: optionalString,
    MAIL_RELAY_TOKEN: optionalString,
    ALERT_TO: optionalString,
    // The agent is stale after this long without a report or a poll (SHP-REQ-093: five minutes).
    HEARTBEAT_STALE_MINUTES: z.preprocess(blankAsUnset, z.coerce.number().int().min(1).max(1440).default(5)),
    // Shipyard's own nightly pg_dump and restore drill (SHP-D-035, SHP-T-6.3).
    // The image creates /backups for the node user; mount a host directory there to keep dumps.
    BACKUP_DIR: z.preprocess(blankAsUnset, z.string().min(1).default('/backups')),
    BACKUP_RETENTION_DAYS: z.preprocess(blankAsUnset, z.coerce.number().int().min(1).max(365).default(14)),
  })
  .transform((c) => ({
    ...c,
    /**
     * True when Sign in with D3 Auth can be attempted: an issuer, a client ID, and a PUBLIC_URL to
     * build the redirect URI from. The client secret is optional (a public client uses PKCE alone).
     */
    oidcConfigured: c.D3AUTH_ISSUER !== undefined && c.D3AUTH_CLIENT_ID !== undefined && c.PUBLIC_URL !== undefined,
  }));
export type Config = z.infer<typeof Config>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Config.parse(env);
}
