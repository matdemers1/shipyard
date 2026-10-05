// Push registration (SHP-T-11.4, the D3 App contract's push): D3 Constellation registers this
// connection at the relay, then tells Shipyard where to send and the key to seal to. Answered 204,
// then one shipyard.registered notification — "Notifications are on" — so the person knows push works.
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { refusal } from '@shipyard/schema';
import { z } from 'zod';
import type { ServiceDeps } from '../deps.js';
import { sendProblem } from '../errors.js';
import { deriveSettingsKey, encryptSecret } from '../settings/crypto.js';
import { isDevicePublicKey } from './envelope.js';
import { push } from './relay.js';

const Register = z.object({
  devicePublicKey: z.string().min(1).max(200),
  relay: z.object({ url: z.string().min(1).max(500), registration: z.string().min(1).max(200), sendKey: z.string().min(16).max(200) }),
  categories: z.array(z.string().regex(/^[a-z][a-z0-9]*\.[a-z_]+$/)).max(20),
});

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Mounted at `/api/push`. */
export function pushRouter(deps: ServiceDeps): Router {
  const { db, config, logger } = deps;
  const router = Router();

  /** https, or a loopback http relay where the test configuration allows one — never in production. */
  const relayUrlOk = (raw: string): boolean => {
    try {
      const url = new URL(raw);
      if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return false;
      if (url.protocol === 'https:') return true;
      return url.protocol === 'http:' && config.RELAY_ALLOW_LOOPBACK_HTTP === '1' && LOOPBACK.has(url.hostname);
    } catch {
      return false;
    }
  };

  router.post('/native/register', async (req, res) => {
    const secret = config.SESSION_SECRET;
    if (secret === undefined) {
      sendProblem(res, 503, refusal('invalid_request', 'Push is not configured on this server.', 'Set SESSION_SECRET.'));
      return;
    }
    // A native app's own session (or a D3 Auth token's row) — never the console's cookie or an API token.
    const native = req.nativeSession;
    if (native === undefined || req.actor?.type !== 'user' || req.actor.id === undefined) {
      sendProblem(res, 401, refusal('unauthenticated', 'Sign in again.'));
      return;
    }
    const userId = req.actor.id;
    const parsed = Register.safeParse(req.body);
    const devicePublicKey = parsed.success ? Buffer.from(parsed.data.devicePublicKey, 'base64') : null;
    if (!parsed.success || devicePublicKey === null || !isDevicePublicKey(devicePublicKey) || !relayUrlOk(parsed.data.relay.url)) {
      sendProblem(res, 400, refusal('invalid_request', 'That is not a relay registration.'));
      return;
    }
    const { relay, categories } = parsed.data;

    // Whose it is: a session Shipyard issued keeps it until it ends; a D3 Auth token's row is
    // short-lived and governed by D3 Auth, so its registration belongs to the identity.
    const row = await db.session.findUniqueOrThrow({
      where: { id: native.id },
      select: { d3authIssuer: true, _count: { select: { refreshes: true } } },
    });
    let owner: { sessionId: string } | { identityId: string };
    if (row._count.refreshes > 0) {
      owner = { sessionId: native.id };
    } else if (row.d3authIssuer !== null) {
      const identity = await db.identity.findFirst({ where: { userId, issuer: row.d3authIssuer }, select: { id: true } });
      if (identity === null) {
        sendProblem(res, 401, refusal('unauthenticated', 'Link this D3 Auth account first.'), { type: 'https://d3cloud.io/problems/identity_not_linked' });
        return;
      }
      owner = { identityId: identity.id };
    } else {
      sendProblem(res, 401, refusal('unauthenticated', 'Sign in again.'));
      return;
    }

    const relayUrl = relay.url.replace(/\/$/, '');
    const created = await db.$transaction(async (tx) => {
      // Registering again replaces the earlier registration for that session (or that relay slot).
      await tx.relayRegistration.deleteMany({
        where: { OR: [...('sessionId' in owner ? [{ sessionId: owner.sessionId }] : []), { relayUrl, registration: relay.registration }] },
      });
      return tx.relayRegistration.create({
        data: {
          id: randomUUID(),
          userId,
          ...owner,
          devicePublicKey: new Uint8Array(devicePublicKey),
          relayUrl,
          registration: relay.registration,
          sendKeySealed: encryptSecret(relay.sendKey, deriveSettingsKey(secret)),
          categories,
        },
      });
    });
    await req.audit({
      action: 'push.registered',
      entityType: 'relay_registration',
      entityId: created.id,
      after: { relay: relayUrl, categories, owner: 'sessionId' in owner ? 'session' : 'identity' },
    });
    res.status(204).end();

    // After the answer, never instead of it: a relay that is down must not fail the registration.
    void push(
      { db, logger, sessionSecret: secret },
      created,
      { v: 1, category: 'shipyard.registered', title: 'Notifications are on', body: 'Shipyard will tell this device when a deploy waits for you.', sentAt: new Date().toISOString() },
    );
  });

  return router;
}
