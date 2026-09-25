import type { D3AuthSource } from '@shipyard/schema';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { decryptSecret, deriveSettingsKey } from '../settings/crypto.js';
import { relayFromConfig, type RelayConfig, type RelaySource } from './index.js';

/**
 * Where alert email goes, resolved live (SHP-REQ-093, SHP-T-6.9): server.env when it names any of
 * MAIL_RELAY_URL / MAIL_RELAY_TOKEN / ALERT_TO (env wins, and the console shows it read-only),
 * otherwise the `mail` setting an admin saved in the console, with the token sealed under the
 * settings key (settings/crypto.ts). Read on every send, so a save needs no restart.
 *
 * Nothing here throws for a bad configuration: an unreadable row, a token sealed under an old
 * SESSION_SECRET, or a missing database all come out as "not configured", with the reason.
 */

export const MAIL_SETTING_KEY = 'mail';

/** The `setting.value` JSON for alert email. `token` is sealed, never plaintext. */
export interface StoredMail {
  relayUrl: string;
  token: string | null;
  alertTo: string;
}

export function parseStoredMail(value: unknown): StoredMail | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['relayUrl'] !== 'string' || typeof v['alertTo'] !== 'string') return null;
  const token = v['token'];
  return { relayUrl: v['relayUrl'], alertTo: v['alertTo'], token: typeof token === 'string' ? token : null };
}

/** True when server.env names any part of alert email: then it owns it, and the console is read-only. */
export function envOwnsMail(config: Pick<Config, 'MAIL_RELAY_URL' | 'MAIL_RELAY_TOKEN' | 'ALERT_TO'>): boolean {
  return config.MAIL_RELAY_URL !== undefined || config.MAIL_RELAY_TOKEN !== undefined || config.ALERT_TO !== undefined;
}

export interface MailState {
  source: D3AuthSource;
  relayUrl: string | null;
  alertTo: string | null;
  tokenSet: boolean;
  /** What a send would use right now; null when nothing would be sent. Holds the plaintext token. */
  relay: RelayConfig | null;
  /** Why it is configured but cannot send, in a sentence. */
  problem: string | null;
  updatedAt: Date | null;
}

const NONE: MailState = { source: 'none', relayUrl: null, alertTo: null, tokenSet: false, relay: null, problem: null, updatedAt: null };

export interface MailSettingsDeps {
  db: Db;
  config: Config;
  logger: Logger;
}

export async function resolveMail(deps: MailSettingsDeps): Promise<MailState> {
  const { db, config, logger } = deps;
  if (envOwnsMail(config)) {
    const relay = relayFromConfig(config);
    return {
      ...NONE,
      source: 'env',
      relayUrl: config.MAIL_RELAY_URL ?? null,
      alertTo: config.ALERT_TO ?? null,
      tokenSet: config.MAIL_RELAY_TOKEN !== undefined,
      relay,
      problem: relay === null ? 'server.env needs MAIL_RELAY_URL, MAIL_RELAY_TOKEN and ALERT_TO all set.' : null,
    };
  }

  let row: { value: unknown; updatedAt: Date } | null;
  try {
    row = await db.setting.findUnique({ where: { key: MAIL_SETTING_KEY }, select: { value: true, updatedAt: true } });
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'could not read the alert email setting');
    return { ...NONE, problem: 'The stored alert email setting could not be read.' };
  }
  const stored = row === null ? null : parseStoredMail(row.value);
  if (row === null || stored === null) return NONE;

  const base: MailState = {
    ...NONE,
    source: 'settings',
    relayUrl: stored.relayUrl,
    alertTo: stored.alertTo,
    tokenSet: stored.token !== null,
    updatedAt: row.updatedAt,
  };
  if (stored.token === null) return { ...base, problem: 'No relay token is stored. Save one to send alert email.' };
  if (config.SESSION_SECRET === undefined) {
    return { ...base, problem: 'The stored relay token cannot be read: SESSION_SECRET is unset in server.env.' };
  }
  try {
    const token = decryptSecret(stored.token, deriveSettingsKey(config.SESSION_SECRET));
    return { ...base, relay: { url: stored.relayUrl, token, to: stored.alertTo } };
  } catch (error) {
    logger.warn('the stored relay token cannot be decrypted; alert email is off');
    return { ...base, problem: error instanceof Error ? error.message : 'The stored relay token cannot be read.' };
  }
}

/** A {@link RelaySource} for `createMailer`: the effective relay, looked up on every send. */
export function liveRelay(deps: MailSettingsDeps): RelaySource {
  return async () => (await resolveMail(deps)).relay;
}
