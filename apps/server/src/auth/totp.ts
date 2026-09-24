import { Secret, TOTP } from 'otpauth';

/** RFC 6238 as every authenticator app expects it: SHA1, 6 digits, 30 s. */
const PERIOD_S = 30;
const DIGITS = 6;
const ALGORITHM = 'SHA1';
/** One step either side, to forgive clock skew. */
const WINDOW = 1;
const ISSUER = 'Shipyard';

function totpFor(secret: string, label = 'shipyard'): TOTP {
  return new TOTP({
    issuer: ISSUER,
    label,
    algorithm: ALGORITHM,
    digits: DIGITS,
    period: PERIOD_S,
    secret: Secret.fromBase32(secret),
  });
}

/** A new random 160-bit secret, base32-encoded (what `user.totpSecret` stores). */
export function generateTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

/** The `otpauth://` URI an authenticator app enrols from (usually shown as a QR code). */
export function totpUri(secret: string, email: string): string {
  return totpFor(secret, email).toString();
}

/** The code for `secret` at `timestamp` (ms). For tests and enrolment checks. */
export function totpCode(secret: string, timestamp: number = Date.now()): string {
  return totpFor(secret).generate({ timestamp });
}

/**
 * The absolute time step `code` is valid for (within ±1 step of `timestamp`), or null. The step
 * is what replay protection compares: a code is spent once its step has been used.
 */
export function matchTotpStep(secret: string, code: string, timestamp: number = Date.now()): number | null {
  if (!/^[0-9]{6}$/.test(code)) return null;
  let delta: number | null;
  try {
    delta = totpFor(secret).validate({ token: code, timestamp, window: WINDOW });
  } catch {
    return null;
  }
  if (delta === null) return null;
  return Math.floor(timestamp / 1000 / PERIOD_S) + delta;
}

/** True when `code` is valid for `secret` now (±1 step). Does not track reuse; see {@link TotpReplayGuard}. */
export function verifyTotp(secret: string, code: string, timestamp: number = Date.now()): boolean {
  return matchTotpStep(secret, code, timestamp) !== null;
}

/**
 * Remembers the last time step each user spent, so a code (or an earlier one still inside the
 * window) cannot be used twice. In memory: a restart forgets, which costs at most one window.
 */
export class TotpReplayGuard {
  private readonly lastStep = new Map<string, number>();

  /** Verifies and, on success, spends the step. False for a wrong code or a reused one. */
  consume(userId: string, secret: string, code: string, timestamp: number = Date.now()): boolean {
    const step = matchTotpStep(secret, code, timestamp);
    if (step === null) return false;
    const last = this.lastStep.get(userId);
    if (last !== undefined && step <= last) return false;
    this.lastStep.set(userId, step);
    return true;
  }
}
