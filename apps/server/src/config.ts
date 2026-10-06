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
    /** Accept a loopback http push relay — CI's mock relay only; production relays are https (SHP-T-11.4). */
    RELAY_ALLOW_LOOPBACK_HTTP: optionalString,
    LOG_LEVEL: z.string().min(1).default('info'),
    SHIPYARD_VERSION: z.string().min(1).default('dev'),
    // Sign in with D3 Auth (SHP-REQ-001). All optional: blank means app-native login only.
    D3AUTH_ISSUER: optionalString,
    D3AUTH_CLIENT_ID: optionalString,
    D3AUTH_CLIENT_SECRET: optionalString,
    // Optional: record deploys in Foreman through the outbox (SHP-D-033, SHP-D-062).
    FOREMAN_URL: optionalString,
    FOREMAN_TOKEN: optionalString,
    // Read-only PAT for changelogs on the console (the agent holds its own, SHP-D-043). Never
    // used to write — see GITHUB_TOKEN_STATUS below, which is a separate token on purpose.
    GITHUB_TOKEN_SERVER: optionalString,
    // Optional: a fine-grained, WRITE-scoped PAT ("Commit statuses: Read and write" on the built
    // repos only) used to post `shipyard/test` and `shipyard/build` commit statuses (SHP-REQ-146).
    // Unset means statuses are not posted — logged once, never a fallback to GITHUB_TOKEN_SERVER,
    // which is read-only by design.
    GITHUB_TOKEN_STATUS: optionalString,
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
    // The GitHub push webhook's shared secret (SHP-REQ-112). Unset means the webhook refuses every
    // delivery with 503 and only the reconcile loop queues builds (SHP-REQ-114).
    GITHUB_WEBHOOK_SECRET: z.preprocess(blankAsUnset, z.string().min(20, 'GITHUB_WEBHOOK_SECRET must be at least 20 characters').optional()),
    // How often the default-branch head of every `build: shipyard` app is reconciled (SHP-REQ-114).
    BUILD_RECONCILE_INTERVAL_SECONDS: z.preprocess(blankAsUnset, z.coerce.number().int().min(30).max(86_400).default(300)),
    // The app name of Shipyard's own server manifest (docs/manifests/shipyard.yml). A rollout always
    // ships it last, so its restart never interrupts the apps before it (SHP-REQ-152).
    SELF_APP: z.preprocess(blankAsUnset, z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).default('shipyard')),
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
