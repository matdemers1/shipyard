import type { RequestHandler, Response, Router } from 'express';
import type { z } from 'zod';
import { MailSettingsUpdate, refusal, type MailSettings, type MailTestResult } from '@shipyard/schema';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { sendRefusal } from '../errors.js';
import { postToRelay } from '../mail/index.js';
import { MAIL_SETTING_KEY, envOwnsMail, parseStoredMail, resolveMail, type MailState } from '../mail/settings.js';
import type { Logger } from 'pino';
import { deriveSettingsKey, encryptSecret } from './crypto.js';

/**
 * Settings → Alert email (SHP-REQ-093, SHP-T-6.9): the mail relay, its bearer token and who
 * receives alerts, stored in the `setting` table under `mail` with the token sealed like the D3
 * Auth client secret. Write-only token; env wins (409 on every write); every change audited
 * without the token. The mailer reads this live (mail/settings.ts), so a save needs no restart.
 */

export interface MailRouteDeps {
  db: Db;
  config: Config;
  logger: Logger;
  /** Test-only: a shorter timeout for Send test email. */
  mailTestTimeoutMs?: number;
}

const ENV_OWNED = refusal(
  'conflict',
  'Alert email is set in server.env, which wins over Settings.',
  'Change MAIL_RELAY_URL, MAIL_RELAY_TOKEN and ALERT_TO in server.env and restart — or remove all three there to manage it here.',
);
const NO_SESSION_SECRET = refusal(
  'conflict',
  'Shipyard cannot store a relay token while SESSION_SECRET is unset: it would be unreadable after a restart.',
  'Set SESSION_SECRET in server.env (32 random bytes), restart, then save the token again.',
);
const TOKEN_REQUIRED = refusal('invalid_request', 'The relay token is required.', 'Paste the relay’s secret into Relay token, then save.');
const RELAY_CHANGED = refusal(
  'invalid_request',
  'The relay URL changed, and the stored token was saved for the old one.',
  'Paste the token for the new relay as well, then save.',
);
const NOT_CONFIGURED = refusal(
  'conflict',
  'Alert email is not configured, so there is nothing to test.',
  'Save a relay URL, token and recipient first — or set them in server.env.',
);

export const TEST_SUBJECT = 'Shipyard test alert';

function view(state: MailState, config: Config): MailSettings {
  return {
    source: state.source,
    relayUrl: state.relayUrl,
    tokenSet: state.tokenSet,
    alertTo: state.alertTo,
    active: state.relay !== null,
    canStoreSecret: config.SESSION_SECRET !== undefined,
    problem: state.problem,
    updatedAt: state.updatedAt?.toISOString() ?? null,
  };
}

export function addMailRoutes(
  router: Router,
  deps: MailRouteDeps,
  admin: RequestHandler[],
  bad: (res: Response, issues: z.core.$ZodIssue[]) => void,
): void {
  const { db, config } = deps;
  const current = async (): Promise<MailSettings> => view(await resolveMail(deps), config);

  async function readStored() {
    const row = await db.setting.findUnique({ where: { key: MAIL_SETTING_KEY } });
    return row === null ? null : parseStoredMail(row.value);
  }

  router.get('/mail', ...admin, async (_req, res) => {
    res.json(await current());
  });

  router.put('/mail', ...admin, async (req, res) => {
    if (envOwnsMail(config)) {
      sendRefusal(res, ENV_OWNED);
      return;
    }
    const parsed = MailSettingsUpdate.safeParse(req.body);
    if (!parsed.success) {
      bad(res, parsed.error.issues);
      return;
    }
    const { relayUrl, token, alertTo } = parsed.data;
    const existing = await readStored();

    let sealed: string;
    if (token !== undefined) {
      if (config.SESSION_SECRET === undefined) {
        sendRefusal(res, NO_SESSION_SECRET);
        return;
      }
      sealed = encryptSecret(token, deriveSettingsKey(config.SESSION_SECRET));
    } else {
      if (existing === null || existing.token === null) {
        sendRefusal(res, TOKEN_REQUIRED);
        return;
      }
      // A bearer token goes only to the relay it was saved for.
      if (existing.relayUrl !== relayUrl) {
        sendRefusal(res, RELAY_CHANGED);
        return;
      }
      sealed = existing.token;
    }

    const value = { relayUrl, token: sealed, alertTo };
    const updatedById = req.actor?.id ?? null;
    await db.setting.upsert({
      where: { key: MAIL_SETTING_KEY },
      create: { key: MAIL_SETTING_KEY, value, updatedById },
      update: { value, updatedById },
    });
    // Never the token, sealed or not: only that one is set and whether this save changed it.
    await req.audit({
      action: 'settings.mail.updated',
      entityType: 'setting',
      entityId: MAIL_SETTING_KEY,
      ...(existing !== null
        ? { before: { relayUrl: existing.relayUrl, alertTo: existing.alertTo, tokenSet: existing.token !== null } }
        : {}),
      after: { relayUrl, alertTo, tokenSet: true, tokenChanged: token !== undefined },
    });
    res.json(await current());
  });

  router.delete('/mail', ...admin, async (req, res) => {
    if (envOwnsMail(config)) {
      sendRefusal(res, ENV_OWNED);
      return;
    }
    const existing = await readStored();
    if (existing === null) {
      req.noAuditNeeded('alert email was not configured in Settings; nothing to clear');
    } else {
      await db.setting.deleteMany({ where: { key: MAIL_SETTING_KEY } });
      await req.audit({
        action: 'settings.mail.cleared',
        entityType: 'setting',
        entityId: MAIL_SETTING_KEY,
        before: { relayUrl: existing.relayUrl, alertTo: existing.alertTo, tokenSet: existing.token !== null },
      });
    }
    res.json(await current());
  });

  router.post('/mail/test', ...admin, async (req, res) => {
    const state = await resolveMail(deps);
    if (state.relay === null) {
      sendRefusal(
        res,
        state.problem === null ? NOT_CONFIGURED : { ...NOT_CONFIGURED, message: `Alert email cannot send: ${state.problem}` },
      );
      return;
    }
    const who = req.actor?.label ?? 'an admin';
    const text = [
      `This is a test of Shipyard's alert email, sent from Settings by ${who}.`,
      `Instance: ${config.PUBLIC_URL ?? '(PUBLIC_URL is unset)'}`,
      '',
      `Real alerts come to this address when the agent has been silent for more than ${String(config.HEARTBEAT_STALE_MINUTES)} minutes, or a nightly backup or restore drill fails.`,
    ].join('\n');
    // Straight to the relay, not through the mailer: a test is never suppressed as a repeat.
    const answer = await postToRelay(
      state.relay,
      { subject: TEST_SUBJECT, text },
      deps.mailTestTimeoutMs !== undefined ? { timeoutMs: deps.mailTestTimeoutMs } : {},
    );
    const result: MailTestResult = {
      sent: answer.ok,
      ...(answer.status !== undefined ? { status: answer.status } : {}),
      ...(answer.detail !== undefined ? { detail: answer.detail } : {}),
    };
    await req.audit({
      action: 'settings.mail.tested',
      entityType: 'setting',
      entityId: MAIL_SETTING_KEY,
      after: { source: state.source, relayUrl: state.relay.url, alertTo: state.relay.to, sent: result.sent, status: result.status ?? null },
    });
    res.json(result);
  });
}
