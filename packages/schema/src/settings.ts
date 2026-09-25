import { z } from 'zod';

/**
 * Settings → Sign in with D3 Auth (SHP-REQ-110, SHP-T-6.8). An admin configures the issuer, client
 * ID and client secret in the console instead of server.env; it takes effect without a restart.
 * The secret is write-only: no response ever carries it, only whether one is set.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * True for an issuer URL Shipyard will talk to: https, or plain http only to this machine (local
 * development). No credentials, query or fragment — an issuer identifier has none (OIDC Discovery §2).
 */
export function isAllowedIssuer(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

export const IssuerUrl = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(isAllowedIssuer, 'must be an https URL (plain http only for localhost), with no query or fragment')
  .meta({ id: 'IssuerUrl', description: 'An OpenID Connect issuer: https, or http only for localhost' });
export type IssuerUrl = z.infer<typeof IssuerUrl>;

export const D3AuthSource = z
  .enum(['env', 'settings', 'none'])
  .meta({
    id: 'D3AuthSource',
    description: 'Where Sign in with D3 Auth is configured: server.env (read-only here), Settings, or nowhere',
  });
export type D3AuthSource = z.infer<typeof D3AuthSource>;

export const D3AuthSettingsUpdate = z
  .strictObject({
    issuer: IssuerUrl,
    clientId: z.string().trim().min(1).max(200),
    /** Omit to keep the stored secret. Never echoed back. */
    clientSecret: z.string().min(1).max(1024).optional(),
    /** True to remove the stored secret (a public client, PKCE alone). */
    clearSecret: z.boolean().optional(),
  })
  .refine((v) => !(v.clientSecret !== undefined && v.clearSecret === true), 'Send a new clientSecret or clearSecret, not both.')
  .meta({ id: 'D3AuthSettingsUpdate', description: 'Save the D3 Auth issuer, client ID and (write-only) client secret' });
export type D3AuthSettingsUpdate = z.infer<typeof D3AuthSettingsUpdate>;

export const D3AuthTestRequest = z
  .strictObject({ issuer: IssuerUrl.optional() })
  .meta({ id: 'D3AuthTestRequest', description: 'Fetch an issuer’s discovery document; omit issuer to test the one in use' });
export type D3AuthTestRequest = z.infer<typeof D3AuthTestRequest>;

export const D3AuthTestResult = z
  .strictObject({
    ok: z.boolean(),
    issuer: z.string().min(1),
    /** The `issuer` the discovery document names, when it could be read. */
    discoveredIssuer: z.string().nullable(),
    issuerMatches: z.boolean(),
    authorizationEndpoint: z.string().nullable(),
    tokenEndpoint: z.string().nullable(),
    jwksUri: z.string().nullable(),
    /** What went wrong, in a sentence; null when ok. */
    error: z.string().nullable(),
  })
  .meta({ id: 'D3AuthTestResult', description: 'What the issuer’s discovery document said' });
export type D3AuthTestResult = z.infer<typeof D3AuthTestResult>;

export const D3AuthSettings = z
  .strictObject({
    source: D3AuthSource,
    issuer: z.string().nullable(),
    clientId: z.string().nullable(),
    /** Whether a client secret is stored. The secret itself is never returned. */
    clientSecretSet: z.boolean(),
    /** Built from PUBLIC_URL; null when PUBLIC_URL is unset (and D3 Auth then cannot work). */
    redirectUri: z.string().nullable(),
    /** True when the D3 Auth button is on the sign-in page right now. */
    available: z.boolean(),
    /** Whether discovery succeeded when the client was last built; null when not configured. */
    reachable: z.boolean().nullable(),
    /** False when SESSION_SECRET is unset: a secret could not be read back after a restart. */
    canStoreSecret: z.boolean(),
    /** Why D3 Auth is configured but unavailable, in a sentence; null otherwise. */
    problem: z.string().nullable(),
    /** The app manifest to upload in D3 Auth's console; null when PUBLIC_URL is unset. */
    manifest: z.record(z.string(), z.unknown()).nullable(),
    updatedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'D3AuthSettings', description: 'Sign in with D3 Auth as configured — never the client secret' });
export type D3AuthSettings = z.infer<typeof D3AuthSettings>;

/**
 * Settings → Alert email (SHP-REQ-093, SHP-T-6.9). The mail relay the stale-agent and failed
 * backup/drill alerts go through — on the D3 host, D3 Auth's mail-relay Worker — and who receives
 * them. The relay token is write-only, like the D3 Auth client secret: only `tokenSet` comes back.
 * MAIL_RELAY_URL / MAIL_RELAY_TOKEN / ALERT_TO in server.env win, and the screen shows them read-only.
 */

export const RelayUrl = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(isAllowedIssuer, 'must be an https URL (plain http only for localhost), with no query or fragment')
  .meta({ id: 'RelayUrl', description: 'The mail relay endpoint: https, or http only for localhost' });
export type RelayUrl = z.infer<typeof RelayUrl>;

export const MailSettingsUpdate = z
  .strictObject({
    relayUrl: RelayUrl,
    /** The relay's bearer token. Omit to keep the stored one. Never echoed back. */
    token: z.string().min(1).max(1024).optional(),
    /** Who receives alert emails. */
    alertTo: z.email().max(320),
  })
  .meta({ id: 'MailSettingsUpdate', description: 'Save the mail relay URL, its (write-only) token and the alert recipient' });
export type MailSettingsUpdate = z.infer<typeof MailSettingsUpdate>;

export const MailSettings = z
  .strictObject({
    /** server.env (read-only here), Settings, or nowhere. */
    source: D3AuthSource,
    relayUrl: z.string().nullable(),
    /** Whether a relay token is set. The token itself is never returned. */
    tokenSet: z.boolean(),
    alertTo: z.string().nullable(),
    /** True when an alert would be emailed right now. */
    active: z.boolean(),
    /** False when SESSION_SECRET is unset: a token could not be read back after a restart. */
    canStoreSecret: z.boolean(),
    /** Why it is configured but cannot send, in a sentence; null otherwise. */
    problem: z.string().nullable(),
    updatedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'MailSettings', description: 'Alert email as configured — never the relay token' });
export type MailSettings = z.infer<typeof MailSettings>;

export const MailTestResult = z
  .strictObject({
    /** True when the relay accepted the message. */
    sent: z.boolean(),
    /** The relay's HTTP status, when it answered. */
    status: z.int().min(100).max(599).optional(),
    /** What the relay said (truncated), or why it could not be reached. */
    detail: z.string().max(500).optional(),
  })
  .meta({ id: 'MailTestResult', description: 'What the mail relay answered to one test message' });
export type MailTestResult = z.infer<typeof MailTestResult>;
