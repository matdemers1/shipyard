/**
 * Which MFA tickets may still finish a sign-in (SHP-REQ-107). A ticket is live only while it is
 * the latest one issued to its user and has not been consumed; a completed sign-in consumes it,
 * and a new password step supersedes the previous one, so neither a replayed cookie nor repeated
 * `/login`s can reach a second session or a fresh budget of TOTP guesses alongside the old one.
 */

export type TicketState = 'live' | 'spent' | 'superseded';

const DEFAULT_MAX_ENTRIES = 10_000;

export class MfaTickets {
  /** userId → the nonce of the latest ticket issued, and when it expires. */
  private readonly latest = new Map<string, { nonce: string; expiresAt: number }>();
  /** nonce → expiry, for tickets that completed a sign-in. */
  private readonly consumed = new Map<string, number>();

  constructor(private readonly maxEntries: number = DEFAULT_MAX_ENTRIES) {}

  /** Records `nonce` as the user's only live ticket. */
  issue(userId: string, nonce: string, expiresAt: number, now: number): void {
    this.sweep(now);
    this.latest.delete(userId);
    this.latest.set(userId, { nonce, expiresAt });
  }

  state(ticket: { userId: string; nonce: string }, now: number): TicketState {
    this.sweep(now);
    if (this.consumed.has(ticket.nonce)) return 'spent';
    return this.latest.get(ticket.userId)?.nonce === ticket.nonce ? 'live' : 'superseded';
  }

  /**
   * Spends a live ticket. Synchronous, so of two concurrent requests with the same ticket exactly
   * one gets true.
   */
  consume(ticket: { userId: string; nonce: string; expiresAt: number }, now: number): boolean {
    if (this.state(ticket, now) !== 'live') return false;
    this.latest.delete(ticket.userId);
    this.consumed.set(ticket.nonce, ticket.expiresAt);
    return true;
  }

  private sweep(now: number): void {
    for (const [nonce, expiresAt] of this.consumed) if (expiresAt <= now) this.consumed.delete(nonce);
    for (const [userId, t] of this.latest) if (t.expiresAt <= now) this.latest.delete(userId);
    // Dropping the oldest consumed nonce is safe: it is also absent from `latest`, so it is refused
    // as superseded either way.
    while (this.consumed.size > this.maxEntries) {
      const oldest = this.consumed.keys().next();
      if (oldest.done === true) break;
      this.consumed.delete(oldest.value);
    }
    while (this.latest.size > this.maxEntries) {
      const oldest = this.latest.keys().next();
      if (oldest.done === true) break;
      this.latest.delete(oldest.value);
    }
  }
}
