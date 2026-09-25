import type { Logger } from 'pino';
import type { Config } from '../config.js';

/**
 * Alert email through an HTTP mail relay (SHP-T-6.4). On the D3 host that is D3 Auth's Worker —
 * one sending credential for the whole ecosystem, not a second one to rotate. The relay takes
 * `POST {to, subject, text}` with a bearer token.
 *
 * Alerts are for what nobody would otherwise notice (a stale agent, a failed backup or drill),
 * repeated at most once an hour per kind: an alert that repeats every minute trains its reader to
 * ignore it. Sending never throws — an alert that cannot be sent must not take down what sent it.
 *
 * Where the relay is configured (SHP-T-6.9): server.env, or Settings → Alert email. A mailer built
 * with a `relay` source asks it on every send, so a save in the console applies without a restart.
 */

export type AlertKind = 'agent-stale' | 'backup-failed' | 'drill-failed';

export interface Alert {
  readonly kind: AlertKind;
  readonly subject: string;
  readonly body: string;
}

export interface MailResult {
  readonly sent: boolean;
  /** Why it was not sent, when it was not. */
  readonly reason?: string;
}

export interface Mailer {
  /**
   * `repeat: true` skips the hourly per-kind suppression, for a caller that already sends once
   * per episode (the stale-agent alert: a second episode within the hour must still be told).
   */
  send(alert: Alert, options?: { repeat?: boolean }): Promise<MailResult>;
}

/** Everything a send needs: where, with what token, to whom. */
export interface RelayConfig {
  readonly url: string;
  readonly token: string;
  readonly to: string;
}

/** The relay in effect right now, or null when none is (fully) configured. */
export type RelaySource = () => Promise<RelayConfig | null>;

const REPEAT_AFTER_MS = 60 * 60 * 1000;
/** A relay that does not answer must not hold up the job that is alerting. */
export const RELAY_TIMEOUT_MS = 10_000;
const DETAIL_MAX = 200;

export interface RelayAnswer {
  readonly ok: boolean;
  /** The relay's HTTP status, when it answered. */
  readonly status?: number;
  /** What it said (truncated, the token redacted), or why it could not be reached. */
  readonly detail?: string;
  /** The underlying error's own message, when the relay could not be reached. */
  readonly error?: string;
}

function redact(text: string, token: string): string {
  return token === '' ? text : text.split(token).join('[redacted]');
}

function describeFetchError(error: unknown, timeoutMs: number): string {
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `The relay did not answer within ${String(timeoutMs / 1000)} seconds.`;
  }
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  const code = typeof cause?.code === 'string' ? ` (${cause.code})` : '';
  return `Could not connect to the relay${code}.`;
}

/**
 * One POST to the relay: bounded in time, following no redirect (a bearer token goes only to the
 * address that was configured). Never throws.
 */
export async function postToRelay(
  relay: RelayConfig,
  message: { subject: string; text: string },
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<RelayAnswer> {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? RELAY_TIMEOUT_MS;
  let res: Response;
  try {
    res = await doFetch(relay.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${relay.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ to: relay.to, subject: message.subject, text: message.text }),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return {
      ok: false,
      detail: describeFetchError(error, timeoutMs),
      error: error instanceof Error ? error.message : String(error),
    };
  }
  let body = '';
  try {
    body = (await res.text()).slice(0, 4 * DETAIL_MAX);
  } catch {
    // The status is the answer; a body that breaks off adds nothing.
  }
  const detail = redact(body, relay.token).trim().slice(0, DETAIL_MAX);
  const ok = res.status >= 200 && res.status < 300;
  return { ok, status: res.status, ...(detail !== '' ? { detail } : {}) };
}

/** The relay server.env names, or null unless all three are set. */
export function relayFromConfig(config: Pick<Config, 'MAIL_RELAY_URL' | 'MAIL_RELAY_TOKEN' | 'ALERT_TO'>): RelayConfig | null {
  const { MAIL_RELAY_URL: url, MAIL_RELAY_TOKEN: token, ALERT_TO: to } = config;
  return url === undefined || token === undefined || to === undefined ? null : { url, token, to };
}

export function createMailer(
  config: Pick<Config, 'MAIL_RELAY_URL' | 'MAIL_RELAY_TOKEN' | 'ALERT_TO' | 'PUBLIC_URL'>,
  logger: Logger,
  deps: { fetch?: typeof fetch; now?: () => Date; relay?: RelaySource; timeoutMs?: number } = {},
): Mailer {
  const now = deps.now ?? (() => new Date());
  const lastSent = new Map<AlertKind, number>();

  async function currentRelay(): Promise<RelayConfig | null> {
    if (deps.relay === undefined) return relayFromConfig(config);
    try {
      return await deps.relay();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'could not read the alert email setting');
      return null;
    }
  }

  return {
    async send(alert, options = {}) {
      const relay = await currentRelay();
      if (relay === null) {
        logger.warn({ kind: alert.kind, subject: alert.subject }, 'alert not emailed: no mail relay is configured');
        return { sent: false, reason: 'no mail relay is configured' };
      }
      const previous = lastSent.get(alert.kind);
      if (options.repeat !== true && previous !== undefined && now().getTime() - previous < REPEAT_AFTER_MS) {
        return { sent: false, reason: 'already alerted about this recently' };
      }
      const answer = await postToRelay(
        relay,
        {
          subject: `[Shipyard] ${alert.subject}`,
          // Plain text: an alert is read on a phone at an awkward moment.
          text: config.PUBLIC_URL === undefined ? alert.body : `${alert.body}\n\n— ${config.PUBLIC_URL}/system`,
        },
        { ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}), ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}) },
      );
      if (answer.status === undefined) {
        const reason = answer.error ?? answer.detail ?? 'the relay could not be reached';
        logger.error({ kind: alert.kind, err: reason }, 'alert email failed');
        return { sent: false, reason };
      }
      if (!answer.ok) {
        logger.error({ kind: alert.kind, status: answer.status, detail: answer.detail }, 'alert email refused');
        return { sent: false, reason: `the relay answered ${String(answer.status)}` };
      }
      lastSent.set(alert.kind, now().getTime());
      logger.info({ kind: alert.kind }, 'alert sent');
      return { sent: true };
    },
  };
}
