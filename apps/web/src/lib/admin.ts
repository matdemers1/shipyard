import { request, type Role } from './api';

/**
 * The admin screens' calls: agent enrolment, API tokens, users and invites, and the out-of-band
 * change count. Each is a thin wrapper over {@link request}, so a refusal arrives as a
 * `RefusalError` with its fix.
 */

// ── Agent (S12) ─────────────────────────────────────────────────────────

/** `GET /api/agent`, one row per agent. */
export interface AgentSummary {
  id: string;
  fingerprint: string;
  confirmed: boolean;
  confirmedAt: string | null;
  confirmedBy: { id: string; email: string; displayName: string } | null;
  enrolledAt: string;
  lastHeartbeatAt: string | null;
  agentVersion: string | null;
  composeVersion: string | null;
  engineApiVersion: string | null;
  stale: boolean;
}

/** A heartbeat older than this (or none at all) is stale — the server's `HEARTBEAT_STALE_MS`. */
export const HEARTBEAT_STALE_MS = 5 * 60 * 1000;

/** Stale when there has never been a heartbeat, or the last one is older than five minutes. */
export function isHeartbeatStale(lastHeartbeatAt: string | null, now: number = Date.now()): boolean {
  if (lastHeartbeatAt === null) return true;
  const at = Date.parse(lastHeartbeatAt);
  return Number.isNaN(at) || now - at > HEARTBEAT_STALE_MS;
}

export interface OutOfBandMonth {
  /** `YYYY-MM`, UTC. */
  month: string;
  count: number;
}

export const agents = {
  list: (): Promise<AgentSummary[]> => request<AgentSummary[]>('/api/agent'),
  confirm: (id: string, fingerprint: string): Promise<AgentSummary> =>
    request<AgentSummary>(`/api/agent/${encodeURIComponent(id)}/confirm`, { method: 'POST', body: { fingerprint } }),
  revoke: (id: string): Promise<AgentSummary> =>
    request<AgentSummary>(`/api/agent/${encodeURIComponent(id)}/revoke`, { method: 'POST' }),
  outOfBand: async (months = 6): Promise<OutOfBandMonth[]> =>
    (await request<{ months: OutOfBandMonth[] }>(`/api/stats/out-of-band?months=${String(months)}`)).months,
};

// ── API tokens (S11) ────────────────────────────────────────────────────

export interface TokenSummary {
  id: string;
  userId: string;
  label: string;
  prefix: string;
  apps: string[];
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
}

export interface TokenCreated {
  id: string;
  label: string;
  prefix: string;
  apps: string[];
  /** Shown once; only its hash is stored. */
  token: string;
}

export const tokens = {
  list: (): Promise<TokenSummary[]> => request<TokenSummary[]>('/api/tokens'),
  create: (label: string, apps: string[]): Promise<TokenCreated> =>
    request<TokenCreated>('/api/tokens', { method: 'POST', body: { label, apps } }),
  revoke: (id: string): Promise<TokenSummary> =>
    request<TokenSummary>(`/api/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** App names for the scope picker. */
  appNames: async (): Promise<string[]> =>
    (await request<{ apps: { name: string }[] }>('/api/apps')).apps.map((a) => a.name),
};

/** The Claude Code MCP config for a token: the server's `/mcp` with a bearer header. */
export function mcpSnippet(origin: string, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        shipyard: {
          type: 'http',
          url: `${origin.replace(/\/+$/, '')}/mcp`,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );
}

// ── Users and invites (S13) ─────────────────────────────────────────────

export interface UserSummary {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  disabled: boolean;
  totpEnrolled: boolean;
  d3authLinked: boolean;
  createdAt: string;
}

export type InviteRole = 'deployer' | 'viewer';

export interface InviteSummary {
  id: string;
  email: string;
  role: Role;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
}

export interface InviteCreated extends InviteSummary {
  token: string;
  /** Shown once: `<PUBLIC_URL>/invite/<token>`. */
  link: string;
}

export interface InvitePreview {
  email: string;
  role: Role;
  expired: boolean;
}

export const users = {
  list: (): Promise<UserSummary[]> => request<UserSummary[]>('/api/users'),
  update: (id: string, patch: { role?: Role; disabled?: boolean }): Promise<UserSummary> =>
    request<UserSummary>(`/api/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
};

export const invites = {
  list: (): Promise<InviteSummary[]> => request<InviteSummary[]>('/api/invites'),
  create: (email: string, role: InviteRole): Promise<InviteCreated> =>
    request<InviteCreated>('/api/invites', { method: 'POST', body: { email, role } }),
  revoke: (id: string): Promise<{ id: string; revokedAt: string | null }> =>
    request(`/api/invites/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // The public steps: nobody is signed in, so a 401 (a wrong code) is not "your session ended".
  preview: (token: string): Promise<InvitePreview> =>
    request<InvitePreview>(`/api/invites/${encodeURIComponent(token)}`, { sessionBearing: false }),
  accept: (token: string, displayName: string, password: string): Promise<{ otpauthUri: string; secret: string }> =>
    request(`/api/invites/${encodeURIComponent(token)}/accept`, {
      method: 'POST',
      body: { displayName, password },
      sessionBearing: false,
    }),
  confirmTotp: (token: string, code: string): Promise<{ ok: true; email: string }> =>
    request(`/api/invites/${encodeURIComponent(token)}/confirm-totp`, {
      method: 'POST',
      body: { code },
      sessionBearing: false,
    }),
};

// ── Formatting ──────────────────────────────────────────────────────────

/** "just now", "6 minutes ago", "3 hours ago", "2 days ago"; "never" for null. */
export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (iso === null) return 'never';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 'unknown';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${String(m)} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${String(h)} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${String(d)} day${d === 1 ? '' : 's'} ago`;
}

/** A short absolute date for lists. */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Copies text; false when the clipboard is unavailable (an insecure origin, or refused). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
