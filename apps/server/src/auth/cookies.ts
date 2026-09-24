import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Logger } from 'pino';
import type { Config } from '../config.js';

export const SESSION_COOKIE = 'shipyard_session';
export const MFA_COOKIE = 'shipyard_mfa';
export const OIDC_TX_COOKIE = 'shipyard_oidc_tx';

/** Parses the Cookie header. No dependency: the format we set is simple and we only read our own. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface CookieOptions {
  maxAgeMs: number;
  path?: string;
}

/** `Secure` only when the public URL is https, so plain-http development still works. */
export function isSecure(config: Config): boolean {
  return config.PUBLIC_URL?.startsWith('https://') ?? false;
}

export function setCookie(res: Response, config: Config, name: string, value: string, options: CookieOptions): void {
  res.cookie(name, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecure(config),
    path: options.path ?? '/',
    maxAge: options.maxAgeMs,
  });
}

export function clearCookie(res: Response, config: Config, name: string, path = '/'): void {
  res.clearCookie(name, { httpOnly: true, sameSite: 'lax', secure: isSecure(config), path });
}

/**
 * The HMAC key for short-lived signed cookies. When `SESSION_SECRET` is unset one is generated,
 * which means a restart invalidates in-flight MFA steps (never sessions: those live in the DB).
 */
export function resolveSessionSecret(config: Config, logger: Logger): string {
  if (config.SESSION_SECRET !== undefined) return config.SESSION_SECRET;
  logger.warn('SESSION_SECRET is unset; generated a random one for this process. Set it in production.');
  return randomBytes(32).toString('base64url');
}

function mac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export interface MfaTicket {
  userId: string;
  /** Random, so attempts can be counted per ticket. */
  nonce: string;
  expiresAt: number;
}

/** `userId.expiresAt.nonce.hmac` — names the user who passed the password step, and nothing else. */
export function signMfaTicket(secret: string, ticket: MfaTicket): string {
  const payload = `${ticket.userId}.${ticket.expiresAt}.${ticket.nonce}`;
  return `${payload}.${mac(secret, payload)}`;
}

/** The ticket, or null when it is malformed, forged or expired. */
export function verifyMfaTicket(secret: string, value: string, now: number = Date.now()): MfaTicket | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const [userId, expires, nonce, sig] = parts as [string, string, string, string];
  const expected = Buffer.from(mac(secret, `${userId}.${expires}.${nonce}`));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const expiresAt = Number(expires);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return null;
  return { userId, nonce, expiresAt };
}
