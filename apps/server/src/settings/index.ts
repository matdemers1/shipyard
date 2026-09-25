import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import {
  D3AuthSettingsUpdate,
  D3AuthTestRequest,
  isAllowedIssuer,
  refusal,
  type D3AuthSettings,
} from '@shipyard/schema';
import { requireUser } from '../auth/index.js';
import { oidcRedirectUri } from '../auth/oidc.js';
import { D3AUTH_SETTING_KEY, envOwnsD3Auth, parseStoredD3Auth, type OidcSettings } from '../auth/oidc-settings.js';
import { requireRole } from '../auth/scope.js';
import type { ServiceDeps } from '../deps.js';
import { sendRefusal } from '../errors.js';
import { deriveSettingsKey, encryptSecret } from './crypto.js';
import { testDiscovery } from './discovery.js';
import { d3authManifest } from './manifest.js';

/**
 * Settings (SHP-REQ-110, SHP-T-6.8), mounted at `/api/settings`. Admin-only and console-only: a
 * viewer, a deployer and every API token are refused before anything is read.
 *
 * Sign in with D3 Auth: the issuer, client ID and client secret, stored in the `setting` table with
 * the secret AES-256-GCM encrypted (settings/crypto.ts). The secret is write-only — no response
 * carries it, and the audit records only whether it changed. A save swaps the live OIDC client
 * without a restart; clearing turns the D3 Auth button off. When server.env sets any `D3AUTH_*`
 * variable, env wins: the screen shows it read-only and every write here is refused.
 */

export interface SettingsDeps extends ServiceDeps {
  oidc: OidcSettings;
  /** Test-only: a shorter discovery timeout for the Test button. */
  discoveryTimeoutMs?: number;
}

const TOKEN_ACTOR = refusal('forbidden', 'An API token cannot read or change settings.', 'Sign in to the console as an admin to do this.');
const ENV_OWNED = refusal(
  'conflict',
  'Sign in with D3 Auth is set in server.env, which wins over Settings.',
  'Change D3AUTH_ISSUER, D3AUTH_CLIENT_ID and D3AUTH_CLIENT_SECRET in server.env and restart — or remove all three there to manage it here.',
);
const NO_PUBLIC_URL = refusal(
  'conflict',
  'PUBLIC_URL is unset, so Shipyard has no redirect URI to give D3 Auth.',
  'Set PUBLIC_URL in server.env to the address people open Shipyard at, restart, then save again.',
);
const NO_SESSION_SECRET = refusal(
  'conflict',
  'Shipyard cannot store a client secret while SESSION_SECRET is unset: it would be unreadable after a restart.',
  'Set SESSION_SECRET in server.env (32 random bytes), restart, then save the secret again.',
);
const ISSUER_CHANGED = refusal(
  'invalid_request',
  'The issuer changed, and the stored client secret was issued by the old one.',
  'Paste the client secret the new issuer gave you, or choose to clear the stored one.',
);
const NO_ISSUER = refusal('invalid_request', 'There is no issuer to test.', 'Enter an issuer address, then Test.');

/** Console-only: a bearer token is refused before anything else. */
const consoleOnly: RequestHandler = (req, res, next) => {
  if (req.actor?.type === 'token') {
    sendRefusal(res, TOKEN_ACTOR);
    return;
  }
  next();
};

function bad(res: Response, issues: z.core.$ZodIssue[]): void {
  sendRefusal(
    res,
    refusal(
      'invalid_request',
      'The settings are not valid.',
      issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
    ),
  );
}

export function settingsRouter(deps: SettingsDeps): Router {
  const { db, config, oidc } = deps;
  const router = Router();
  const admin = [consoleOnly, requireUser, requireRole('admin')];

  function redirectUri(): string | null {
    if (config.PUBLIC_URL === undefined) return null;
    try {
      return oidcRedirectUri(config.PUBLIC_URL);
    } catch {
      return null;
    }
  }

  function view(): D3AuthSettings {
    const state = oidc.state();
    const uri = redirectUri();
    return {
      source: state.source,
      issuer: state.issuer,
      clientId: state.clientId,
      clientSecretSet: state.clientSecretSet,
      redirectUri: uri,
      available: oidc.current() !== null,
      reachable: state.reachable,
      canStoreSecret: config.SESSION_SECRET !== undefined,
      problem: state.problem,
      manifest: uri === null || config.PUBLIC_URL === undefined ? null : d3authManifest(config.PUBLIC_URL, state.clientId ?? 'shipyard'),
      updatedAt: state.updatedAt?.toISOString() ?? null,
    };
  }

  async function readStored() {
    const row = await db.setting.findUnique({ where: { key: D3AUTH_SETTING_KEY } });
    return row === null ? null : parseStoredD3Auth(row.value);
  }

  router.get('/d3auth', ...admin, (_req, res) => {
    res.json(view());
  });

  router.put('/d3auth', ...admin, async (req, res) => {
    if (envOwnsD3Auth(config)) {
      sendRefusal(res, ENV_OWNED);
      return;
    }
    const parsed = D3AuthSettingsUpdate.safeParse(req.body);
    if (!parsed.success) {
      bad(res, parsed.error.issues);
      return;
    }
    if (config.PUBLIC_URL === undefined) {
      sendRefusal(res, NO_PUBLIC_URL);
      return;
    }
    const { issuer, clientId, clientSecret, clearSecret } = parsed.data;
    const existing = await readStored();

    let sealed: string | null;
    if (clientSecret !== undefined) {
      if (config.SESSION_SECRET === undefined) {
        sendRefusal(res, NO_SESSION_SECRET);
        return;
      }
      sealed = encryptSecret(clientSecret, deriveSettingsKey(config.SESSION_SECRET));
    } else if (clearSecret === true) {
      sealed = null;
    } else {
      sealed = existing?.clientSecret ?? null;
      // A secret goes only to the issuer that issued it.
      if (sealed !== null && existing !== null && existing.issuer !== issuer) {
        sendRefusal(res, ISSUER_CHANGED);
        return;
      }
    }

    const value = { issuer, clientId, clientSecret: sealed };
    const updatedById = req.actor?.id ?? null;
    await db.setting.upsert({
      where: { key: D3AUTH_SETTING_KEY },
      create: { key: D3AUTH_SETTING_KEY, value, updatedById },
      update: { value, updatedById },
    });
    // Never the secret, sealed or not: only whether one is set and whether this save changed it.
    await req.audit({
      action: 'settings.d3auth.updated',
      entityType: 'setting',
      entityId: D3AUTH_SETTING_KEY,
      ...(existing !== null
        ? { before: { issuer: existing.issuer, clientId: existing.clientId, clientSecretSet: existing.clientSecret !== null } }
        : {}),
      after: {
        issuer,
        clientId,
        clientSecretSet: sealed !== null,
        secretChanged: clientSecret !== undefined || (clearSecret === true && (existing?.clientSecret ?? null) !== null),
      },
    });
    await oidc.load();
    res.json(view());
  });

  router.delete('/d3auth', ...admin, async (req, res) => {
    if (envOwnsD3Auth(config)) {
      sendRefusal(res, ENV_OWNED);
      return;
    }
    const existing = await readStored();
    if (existing === null) {
      req.noAuditNeeded('D3 Auth was not configured in Settings; nothing to clear');
    } else {
      await db.setting.deleteMany({ where: { key: D3AUTH_SETTING_KEY } });
      await req.audit({
        action: 'settings.d3auth.cleared',
        entityType: 'setting',
        entityId: D3AUTH_SETTING_KEY,
        before: { issuer: existing.issuer, clientId: existing.clientId, clientSecretSet: existing.clientSecret !== null },
      });
    }
    await oidc.load();
    res.json(view());
  });

  router.post('/d3auth/test', ...admin, async (req, res) => {
    const parsed = D3AuthTestRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      bad(res, parsed.error.issues);
      return;
    }
    const issuer = parsed.data.issuer ?? oidc.state().issuer;
    if (issuer === null || !isAllowedIssuer(issuer)) {
      sendRefusal(res, NO_ISSUER);
      return;
    }
    req.noAuditNeeded('a discovery fetch changes nothing');
    res.json(await testDiscovery(issuer, deps.discoveryTimeoutMs !== undefined ? { timeoutMs: deps.discoveryTimeoutMs } : {}));
  });

  return router;
}
