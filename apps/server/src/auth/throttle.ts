/**
 * Failed-attempt throttling for sign-in (SHP-REQ-108). In memory: Shipyard's server is a single
 * process, and a restart forgetting a cool-off costs an attacker one restart, which they cannot
 * cause.
 */

export interface ThrottleLimits {
  /** Failures inside one window that trip the cool-off. */
  maxFailures: number;
  /** The window counted from a key's first failure. */
  windowMs: number;
  /** How long a tripped key is refused. */
  coolOffMs: number;
}

/**
 * Per account *from one source address*: five failures in fifteen minutes pause that pair for
 * fifteen. Keyed by address too, so a stranger's wrong guesses lock out only the stranger, never the
 * account's owner signing in from elsewhere.
 */
export const DEFAULT_ACCOUNT_LIMITS: ThrottleLimits = {
  maxFailures: 5,
  windowMs: 15 * 60 * 1000,
  coolOffMs: 15 * 60 * 1000,
};

/**
 * Per account from anywhere: a much looser ceiling, so guesses spread over many addresses are still
 * capped. Reaching it takes fifty failures in fifteen minutes; the second factor stands behind it.
 */
export const DEFAULT_ACCOUNT_GLOBAL_LIMITS: ThrottleLimits = {
  maxFailures: 50,
  windowMs: 15 * 60 * 1000,
  coolOffMs: 15 * 60 * 1000,
};

/** Per source address: twenty failures across any accounts in fifteen minutes pause it for fifteen. */
export const DEFAULT_IP_LIMITS: ThrottleLimits = {
  maxFailures: 20,
  windowMs: 15 * 60 * 1000,
  coolOffMs: 15 * 60 * 1000,
};

/** Keys tracked at once before the oldest are dropped, so a flood of junk keys cannot grow memory. */
const DEFAULT_MAX_KEYS = 10_000;

interface Entry {
  failures: number;
  windowEndsAt: number;
  blockedUntil: number;
}

export interface ThrottleOptions {
  limits: ThrottleLimits;
  /** The clock, injectable for tests. */
  now?: () => number;
  maxKeys?: number;
}

/** Counts failures per key and refuses a key for `coolOffMs` once it reaches `maxFailures`. */
export class Throttle {
  private readonly entries = new Map<string, Entry>();
  private readonly limits: ThrottleLimits;
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(options: ThrottleOptions) {
    this.limits = options.limits;
    this.now = options.now ?? Date.now;
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  }

  /** The time the key's cool-off ends, or null when it may try. */
  blockedUntil(key: string): number | null {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    return entry.blockedUntil > this.now() ? entry.blockedUntil : null;
  }

  /** Counts one failure; returns true when this failure tripped (or the key already is in) a cool-off. */
  recordFailure(key: string): boolean {
    const now = this.now();
    this.sweep(now);
    let entry = this.entries.get(key);
    if (entry === undefined || (entry.windowEndsAt <= now && entry.blockedUntil <= now)) {
      entry = { failures: 0, windowEndsAt: now + this.limits.windowMs, blockedUntil: 0 };
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    if (entry.blockedUntil > now) return true;
    entry.failures += 1;
    if (entry.failures >= this.limits.maxFailures) {
      entry.blockedUntil = now + this.limits.coolOffMs;
      entry.failures = 0;
      entry.windowEndsAt = entry.blockedUntil;
      return true;
    }
    return false;
  }

  /** Forgets the key's failures (a completed sign-in). */
  reset(key: string): void {
    this.entries.delete(key);
  }

  /** Tracked keys, for tests of the bound. */
  get size(): number {
    return this.entries.size;
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.windowEndsAt <= now && entry.blockedUntil <= now) this.entries.delete(key);
    }
    if (this.entries.size < this.maxKeys) return;
    // Over the bound: shed the oldest keys that are *not* in a cool-off first. Evicting a live block
    // would let a flood of junk keys (many addresses, random emails) clear an account's lockout and
    // buy fresh guesses. Map iteration is insertion order, so the first keys are the oldest.
    for (const [key, entry] of this.entries) {
      if (this.entries.size < this.maxKeys) return;
      if (entry.blockedUntil <= now) this.entries.delete(key);
    }
    // Every tracked key is blocked. Only now does the bound win over the oldest block; a flood
    // big enough to get here has already cost one address's cap for every blocked key.
    while (this.entries.size >= this.maxKeys) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }
}
