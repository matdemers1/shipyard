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

const REPEAT_AFTER_MS = 60 * 60 * 1000;

export function createMailer(
  config: Pick<Config, 'MAIL_RELAY_URL' | 'MAIL_RELAY_TOKEN' | 'ALERT_TO' | 'PUBLIC_URL'>,
  logger: Logger,
  deps: { fetch?: typeof fetch; now?: () => Date } = {},
): Mailer {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const lastSent = new Map<AlertKind, number>();

  return {
    async send(alert, options = {}) {
      const { MAIL_RELAY_URL: url, MAIL_RELAY_TOKEN: token, ALERT_TO: to } = config;
      if (url === undefined || token === undefined || to === undefined) {
        logger.warn({ kind: alert.kind, subject: alert.subject }, 'alert not emailed: no mail relay is configured');
        return { sent: false, reason: 'no mail relay is configured' };
      }
      const previous = lastSent.get(alert.kind);
      if (options.repeat !== true && previous !== undefined && now().getTime() - previous < REPEAT_AFTER_MS) {
        return { sent: false, reason: 'already alerted about this recently' };
      }
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            to,
            subject: `[Shipyard] ${alert.subject}`,
            // Plain text: an alert is read on a phone at an awkward moment.
            text: config.PUBLIC_URL === undefined ? alert.body : `${alert.body}\n\n— ${config.PUBLIC_URL}/system`,
          }),
        });
        if (!res.ok) {
          const detail = (await res.text()).slice(0, 200);
          logger.error({ kind: alert.kind, status: res.status, detail }, 'alert email refused');
          return { sent: false, reason: `the relay answered ${String(res.status)}` };
        }
        lastSent.set(alert.kind, now().getTime());
        logger.info({ kind: alert.kind }, 'alert sent');
        return { sent: true };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.error({ kind: alert.kind, err: reason }, 'alert email failed');
        return { sent: false, reason };
      }
    },
  };
}
