import { describe, expect, it } from 'vitest';
import { Throttle } from '../../../src/auth/throttle.js';
import { MfaTickets } from '../../../src/auth/tickets.js';

const MIN = 60_000;

function make(maxKeys?: number): { t: Throttle; clock: { now: number } } {
  const clock = { now: 1_000_000 };
  const t = new Throttle({
    limits: { maxFailures: 3, windowMs: 10 * MIN, coolOffMs: 15 * MIN },
    now: () => clock.now,
    ...(maxKeys !== undefined ? { maxKeys } : {}),
  });
  return { t, clock };
}

describe('Throttle', () => {
  it('blocks a key when failures reach the threshold, until the cool-off ends', () => {
    const { t, clock } = make();
    expect(t.recordFailure('a')).toBe(false);
    expect(t.recordFailure('a')).toBe(false);
    expect(t.blockedUntil('a')).toBeNull();
    expect(t.recordFailure('a')).toBe(true);
    expect(t.blockedUntil('a')).toBe(clock.now + 15 * MIN);
    expect(t.blockedUntil('b')).toBeNull();

    clock.now += 15 * MIN - 1;
    expect(t.blockedUntil('a')).not.toBeNull();
    clock.now += 1;
    expect(t.blockedUntil('a')).toBeNull();
    // After the cool-off the count starts over.
    expect(t.recordFailure('a')).toBe(false);
  });

  it('forgets failures older than the window', () => {
    const { t, clock } = make();
    t.recordFailure('a');
    t.recordFailure('a');
    clock.now += 10 * MIN;
    expect(t.recordFailure('a')).toBe(false);
    expect(t.recordFailure('a')).toBe(false);
    expect(t.recordFailure('a')).toBe(true);
  });

  it('does not extend a cool-off for failures recorded during it', () => {
    const { t, clock } = make();
    for (let i = 0; i < 3; i += 1) t.recordFailure('a');
    const until = t.blockedUntil('a');
    clock.now += 5 * MIN;
    expect(t.recordFailure('a')).toBe(true);
    expect(t.blockedUntil('a')).toBe(until);
  });

  it('reset clears a key', () => {
    const { t } = make();
    t.recordFailure('a');
    t.recordFailure('a');
    t.reset('a');
    expect(t.recordFailure('a')).toBe(false);
    expect(t.recordFailure('a')).toBe(false);
  });

  it('stays bounded and sweeps expired keys', () => {
    const { t, clock } = make(100);
    for (let i = 0; i < 500; i += 1) t.recordFailure(`k${i}`);
    expect(t.size).toBeLessThanOrEqual(100);
    clock.now += 11 * MIN;
    t.recordFailure('fresh');
    expect(t.size).toBe(1);
  });
});

describe('MfaTickets', () => {
  const T = 1_000_000;

  it('a ticket is live until consumed, then spent', () => {
    const tickets = new MfaTickets();
    const ticket = { userId: 'u', nonce: 'n1', expiresAt: T + 5 * MIN };
    tickets.issue('u', 'n1', ticket.expiresAt, T);
    expect(tickets.state(ticket, T)).toBe('live');
    expect(tickets.consume(ticket, T)).toBe(true);
    expect(tickets.state(ticket, T)).toBe('spent');
    expect(tickets.consume(ticket, T)).toBe(false);
  });

  it('a newer ticket for the same user supersedes the older one', () => {
    const tickets = new MfaTickets();
    const first = { userId: 'u', nonce: 'n1', expiresAt: T + 5 * MIN };
    const second = { userId: 'u', nonce: 'n2', expiresAt: T + 6 * MIN };
    tickets.issue('u', 'n1', first.expiresAt, T);
    tickets.issue('u', 'n2', second.expiresAt, T + MIN);
    expect(tickets.state(first, T + MIN)).toBe('superseded');
    expect(tickets.consume(first, T + MIN)).toBe(false);
    expect(tickets.state(second, T + MIN)).toBe('live');
  });

  it('an unknown ticket (e.g. after a restart) is not live', () => {
    const tickets = new MfaTickets();
    expect(tickets.state({ userId: 'u', nonce: 'x' }, T)).toBe('superseded');
  });
});

describe('Throttle bound', () => {
  it('sheds unblocked keys before a live block when the map is full', () => {
    let now = 0;
    const throttle = new Throttle({
      limits: { maxFailures: 2, windowMs: 1000, coolOffMs: 1000 },
      maxKeys: 4,
      now: () => now,
    });
    throttle.recordFailure('admin');
    throttle.recordFailure('admin');
    expect(throttle.blockedUntil('admin')).toBe(1000);
    for (let i = 0; i < 10; i += 1) throttle.recordFailure(`junk-${String(i)}`);
    expect(throttle.blockedUntil('admin')).toBe(1000);
    now = 1001;
    expect(throttle.blockedUntil('admin')).toBeNull();
  });
});
