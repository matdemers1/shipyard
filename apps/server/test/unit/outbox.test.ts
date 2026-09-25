import { describe, expect, it } from 'vitest';
import { computeBackoffMs } from '../../src/outbox/index.js';

const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const noJitter = (): number => 0.5; // computeBackoffMs maps 0.5 -> exactly 1.0x (no jitter)

describe('computeBackoffMs', () => {
  it('grows exponentially from a 30s base before the cap', () => {
    expect(computeBackoffMs(0, noJitter)).toBe(30_000);
    expect(computeBackoffMs(1, noJitter)).toBe(60_000);
    expect(computeBackoffMs(2, noJitter)).toBe(120_000);
    expect(computeBackoffMs(3, noJitter)).toBe(240_000);
  });

  it('caps at 15 minutes once the exponential growth exceeds it', () => {
    // 30s * 2^6 = 1920s = 32min, already past the 15min cap.
    expect(computeBackoffMs(6, noJitter)).toBe(FIFTEEN_MIN_MS);
    expect(computeBackoffMs(10, noJitter)).toBe(FIFTEEN_MIN_MS);
  });

  it('never throws, overflows, or drops the cap for very large attempt counts (no retry limit)', () => {
    const value = computeBackoffMs(50, noJitter);
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBe(FIFTEEN_MIN_MS);

    const value2 = computeBackoffMs(10_000, noJitter);
    expect(Number.isFinite(value2)).toBe(true);
    expect(value2).toBe(FIFTEEN_MIN_MS);
  });

  it('applies jitter within +/-10% of the base value', () => {
    const low = computeBackoffMs(1, () => 0); // 0.9x
    const high = computeBackoffMs(1, () => 1); // 1.1x (random() < 1 in practice, but bounds check)
    expect(low).toBe(Math.round(60_000 * 0.9));
    expect(high).toBe(Math.round(60_000 * 1.1));

    // Sample a spread of random() outputs and assert every result lands in the [0.9x, 1.1x] band.
    for (let i = 0; i <= 10; i++) {
      const r = i / 10;
      const value = computeBackoffMs(2, () => r);
      expect(value).toBeGreaterThanOrEqual(Math.round(120_000 * 0.9));
      expect(value).toBeLessThanOrEqual(Math.round(120_000 * 1.1));
    }
  });

  it('applies jitter within +/-10% of the cap once capped', () => {
    const low = computeBackoffMs(50, () => 0);
    const high = computeBackoffMs(50, () => 1);
    expect(low).toBe(Math.round(FIFTEEN_MIN_MS * 0.9));
    expect(high).toBe(Math.round(FIFTEEN_MIN_MS * 1.1));
  });
});
