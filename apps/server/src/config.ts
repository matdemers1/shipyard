import { z } from 'zod';

/** `.env.example` ships optional values blank; a blank string means "unset", not "set to ''". */
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
    PORT: z.coerce.number().int().positive().default(3300),
    PUBLIC_URL: optionalString,
    SESSION_SECRET: optionalString,
    LOG_LEVEL: z.string().min(1).default('info'),
    SHIPYARD_VERSION: z.string().min(1).default('dev'),
    // Sign in with D3 Auth (SHP-REQ-001). All optional: blank means app-native login only.
    D3AUTH_ISSUER: optionalString,
    D3AUTH_CLIENT_ID: optionalString,
    D3AUTH_CLIENT_SECRET: optionalString,
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
