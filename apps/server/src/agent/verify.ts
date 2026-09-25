import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { fingerprintOf, refusal, SIGNATURE_WINDOW_MS, signingString } from '@shipyard/schema';
import type { ServiceDeps } from '../deps.js';
import { sendRefusal } from '../errors.js';

/**
 * Verifies an agent's signed request (SHP-REQ-034, SHP-REQ-103; SHP-D-064). The agent signs
 * `signingString(...)` over the method, the path as sent, a timestamp, a nonce and the exact body
 * bytes; the server rebuilds that string from what it received and checks it against the key it
 * holds for the fingerprint in `x-shipyard-key`.
 *
 * Checks run cheapest first, and the signature is verified before the nonce is recorded, so a
 * request nobody signed can never write to the nonce table.
 */

export interface AgentContext {
  /** Null only in enrolment mode, before the agent row exists. */
  id: string | null;
  fingerprint: string;
  /** Base64 of the raw 32-byte Ed25519 public key the request was verified with. */
  publicKeyB64: string;
  confirmed: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      agent?: AgentContext;
      /** The exact JSON body bytes, kept by `express.json({ verify })` in app.ts. */
      rawBody?: Buffer;
    }
  }
}

export interface VerifyAgentOptions {
  /** Let an agent whose fingerprint no owner has confirmed yet through (enrol, heartbeat). */
  allowUnconfirmed?: boolean;
  /** With no agent row for the fingerprint, take the key from the body's `publicKey` (enrol only). */
  enrolment?: boolean;
}

/** Ed25519 SubjectPublicKeyInfo DER is this fixed prefix followed by the raw 32-byte key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const TIMESTAMP_RE = /^\d{1,16}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
/** Roughly one request in this many also sweeps expired nonces. */
const SWEEP_EVERY = 100;

function decodeRawKey(b64: string): Buffer | null {
  if (!BASE64_RE.test(b64)) return null;
  const raw = Buffer.from(b64, 'base64');
  return raw.length === 32 ? raw : null;
}

export function publicKeyFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function unauthenticated(res: Response, message: string): void {
  sendRefusal(res, refusal('unauthenticated', message, 'Check the agent clock and key, then retry with a fresh signed request.'));
}

export function verifyAgentRequest(deps: ServiceDeps, opts: VerifyAgentOptions = {}): RequestHandler {
  const { db, logger } = deps;
  let sinceSweep = 0;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // 1. Headers present and well formed.
    const fingerprint = header(req, 'x-shipyard-key');
    const timestamp = header(req, 'x-shipyard-timestamp');
    const nonce = header(req, 'x-shipyard-nonce');
    const signatureB64 = header(req, 'x-shipyard-signature');
    if (
      fingerprint === undefined ||
      fingerprint.length === 0 ||
      timestamp === undefined ||
      !TIMESTAMP_RE.test(timestamp) ||
      nonce === undefined ||
      nonce.length < 16 ||
      nonce.length > 128 ||
      signatureB64 === undefined ||
      !BASE64_RE.test(signatureB64)
    ) {
      unauthenticated(res, 'The request is missing or has malformed signature headers.');
      return;
    }
    const signature = Buffer.from(signatureB64, 'base64');
    if (signature.length !== 64) {
      unauthenticated(res, 'The request signature is malformed.');
      return;
    }

    // 2. Timestamp within the window, either side.
    const ts = Number(timestamp);
    const now = Date.now();
    if (Math.abs(now - ts) > SIGNATURE_WINDOW_MS) {
      unauthenticated(res, 'The request timestamp is more than five minutes from the server clock.');
      return;
    }

    // 3. The public key: the enrolled agent's, or (enrolment only) the one the body offers.
    const agent = await db.agent.findUnique({
      where: { fingerprint },
      select: { id: true, publicKey: true, confirmedAt: true },
    });
    let rawKey: Buffer | null;
    if (agent !== null) {
      rawKey = decodeRawKey(agent.publicKey);
      if (rawKey === null) {
        logger.error({ agentId: agent.id }, 'stored agent public key is not a raw 32-byte Ed25519 key');
        unauthenticated(res, 'The agent key on record is unusable.');
        return;
      }
    } else if (opts.enrolment === true) {
      const body: unknown = req.body;
      const offered =
        typeof body === 'object' && body !== null && 'publicKey' in body && typeof body.publicKey === 'string'
          ? decodeRawKey(body.publicKey)
          : null;
      if (offered === null || fingerprintOf(offered) !== fingerprint) {
        unauthenticated(res, 'The offered public key does not match the key fingerprint header.');
        return;
      }
      rawKey = offered;
    } else {
      unauthenticated(res, 'No agent is enrolled with this key.');
      return;
    }

    // 4. The signature, over the bytes exactly as received. A body the JSON parser did not capture
    // (another content type) is refused rather than verified as empty: the bytes signed must be
    // the bytes a handler could ever read.
    const declaredLength = Number(req.headers['content-length'] ?? '0');
    if (req.rawBody === undefined && (declaredLength > 0 || req.headers['transfer-encoding'] !== undefined)) {
      unauthenticated(res, 'Agent requests must send their body as application/json.');
      return;
    }
    const data = signingString({
      method: req.method,
      path: req.originalUrl,
      timestamp,
      nonce,
      body: req.rawBody ?? new Uint8Array(0),
    });
    let valid: boolean;
    try {
      valid = verify(null, Buffer.from(data, 'utf8'), publicKeyFromRaw(rawKey), signature);
    } catch (err) {
      logger.warn({ err }, 'agent signature verification threw');
      valid = false;
    }
    if (!valid) {
      unauthenticated(res, 'The request signature does not verify.');
      return;
    }

    // 5. The nonce, once. Kept for twice the window, so a replay inside the window always collides.
    const expiresAt = new Date(ts + 2 * SIGNATURE_WINDOW_MS);
    const inserted = await db.$executeRaw`
      insert into "agent_nonce" ("nonce", "fingerprint", "expires_at")
      values (${nonce}, ${fingerprint}, ${expiresAt})
      on conflict ("nonce") do nothing`;
    if (inserted === 0) {
      unauthenticated(res, 'This request nonce has already been used.');
      return;
    }
    sinceSweep += 1;
    if (sinceSweep >= SWEEP_EVERY) {
      sinceSweep = 0;
      db.agentNonce.deleteMany({ where: { expiresAt: { lt: new Date(now) } } }).catch((err: unknown) => {
        logger.warn({ err }, 'expired nonce sweep failed');
      });
    }

    // 6. Confirmed by an owner, unless this route lets an unconfirmed agent through.
    const confirmed = agent !== null && agent.confirmedAt !== null;
    if (!confirmed && opts.allowUnconfirmed !== true) {
      sendRefusal(res, refusal('not_enrolled', `Agent ${fingerprint} has not been confirmed by an owner.`));
      return;
    }

    // 7. Who this is.
    req.agent = { id: agent?.id ?? null, fingerprint, publicKeyB64: rawKey.toString('base64'), confirmed };
    req.actor = {
      type: 'agent',
      ...(agent !== null ? { id: agent.id } : {}),
      label: `agent ${fingerprint.slice(0, 15)}`,
    };
    next();
  };
}
