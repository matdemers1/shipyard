// Sending through the relay (SHP-T-11.4, d3-app-contract spec/push.md). Shipyard posts a sealed
// envelope to <relay>/v1/push/<registration>, signed with the registration's send key; the relay hands
// it to APNs. A 410 means the device is gone or signed out, and the registration is forgotten. Nothing
// here may fail the request that caused a notification: a push is best effort and logged.
import { createHmac } from 'node:crypto';
import type { Logger } from 'pino';
import type { Db } from '../db.js';
import { decryptSecret, deriveSettingsKey } from '../settings/crypto.js';
import { sealEnvelope } from './envelope.js';

/** notification.v1 — what the device opens. */
export interface Notification {
  v: 1;
  category: string;
  title: string;
  body?: string;
  thread?: string;
  link?: string;
  sentAt: string;
}

export interface Registration {
  id: string;
  devicePublicKey: Uint8Array;
  relayUrl: string;
  registration: string;
  sendKeySealed: string;
}

/** base64url(HMAC-SHA256(sendKey, "<timestamp>.<body>")), as the relay checks it. */
export function signRelayRequest(sendKey: string, timestamp: string, body: string): string {
  return createHmac('sha256', sendKey).update(`${timestamp}.${body}`).digest('base64url');
}

export type PushResult = 'sent' | 'gone' | 'failed';

export interface PushDeps {
  db: Db;
  logger: Logger;
  sessionSecret: string;
}

export async function push(deps: PushDeps, registration: Registration, notification: Notification, collapseId?: string): Promise<PushResult> {
  try {
    const sendKey = decryptSecret(registration.sendKeySealed, deriveSettingsKey(deps.sessionSecret));
    const ciphertext = sealEnvelope(registration.devicePublicKey, Buffer.from(JSON.stringify(notification)));
    const body = JSON.stringify({ ciphertext, priority: 'high', ...(collapseId === undefined ? {} : { collapseId: collapseId.slice(0, 64) }) });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const res = await fetch(`${registration.relayUrl}/v1/push/${encodeURIComponent(registration.registration)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-d3-relay-timestamp': timestamp, 'x-d3-relay-signature': signRelayRequest(sendKey, timestamp, body) },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 410) {
      await deps.db.relayRegistration.deleteMany({ where: { id: registration.id } });
      return 'gone';
    }
    if (!res.ok) {
      deps.logger.warn({ status: res.status, registration: registration.id }, 'relay refused a push');
      return 'failed';
    }
    return 'sent';
  } catch (error) {
    deps.logger.warn({ registration: registration.id, err: error instanceof Error ? error.message : String(error) }, 'push failed');
    return 'failed';
  }
}

/** Every device of these users that asked for `category`, each sent once. */
export async function pushToUsers(deps: PushDeps, userIds: readonly string[], notification: Notification, collapseId?: string): Promise<PushResult[]> {
  if (userIds.length === 0) return [];
  const registrations = await deps.db.relayRegistration.findMany({ where: { userId: { in: [...userIds] }, categories: { has: notification.category } } });
  return Promise.all(registrations.map((r) => push(deps, r, notification, collapseId)));
}
