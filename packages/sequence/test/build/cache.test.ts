import { describe, expect, it } from 'vitest';

import { DEFAULT_GC_INTERVAL_MS, capBytes, dueForGc, limitsChanged, toHostConfigLimits } from '../../src/build/cache.js';

describe('toHostConfigLimits', () => {
  it('converts cpus to NanoCpus and memoryMb to bytes, with MemorySwap equal to Memory', () => {
    expect(toHostConfigLimits({ cpus: 2, memoryMb: 4096 })).toEqual({
      NanoCpus: 2_000_000_000,
      Memory: 4096 * 1024 * 1024,
      MemorySwap: 4096 * 1024 * 1024,
    });
  });

  it('handles a half-CPU step exactly', () => {
    expect(toHostConfigLimits({ cpus: 0.5, memoryMb: 512 }).NanoCpus).toBe(500_000_000);
  });
});

describe('capBytes', () => {
  it('converts GiB to bytes', () => {
    expect(capBytes(20)).toBe(20 * 1024 ** 3);
  });

  it('converts 1 GiB', () => {
    expect(capBytes(1)).toBe(1024 ** 3);
  });
});

describe('limitsChanged', () => {
  it('is true the first time (nothing applied yet)', () => {
    expect(limitsChanged(null, { cpus: 2, memoryMb: 4096 })).toBe(true);
  });

  it('is false when cpus and memoryMb both match what was applied', () => {
    expect(limitsChanged({ cpus: 2, memoryMb: 4096 }, { cpus: 2, memoryMb: 4096 })).toBe(false);
  });

  it('is true when cpus changed', () => {
    expect(limitsChanged({ cpus: 2, memoryMb: 4096 }, { cpus: 4, memoryMb: 4096 })).toBe(true);
  });

  it('is true when memoryMb changed', () => {
    expect(limitsChanged({ cpus: 2, memoryMb: 4096 }, { cpus: 2, memoryMb: 8192 })).toBe(true);
  });
});

describe('dueForGc', () => {
  const now = new Date('2026-09-28T00:00:00.000Z');

  it('is true when GC has never run', () => {
    expect(dueForGc(null, now)).toBe(true);
  });

  it('is false just under the interval', () => {
    const lastGcAt = new Date(now.getTime() - (DEFAULT_GC_INTERVAL_MS - 1000));
    expect(dueForGc(lastGcAt, now)).toBe(false);
  });

  it('is true once the interval has fully elapsed', () => {
    const lastGcAt = new Date(now.getTime() - DEFAULT_GC_INTERVAL_MS);
    expect(dueForGc(lastGcAt, now)).toBe(true);
  });

  it('honours a custom interval', () => {
    const lastGcAt = new Date(now.getTime() - 5000);
    expect(dueForGc(lastGcAt, now, 1000)).toBe(true);
    expect(dueForGc(lastGcAt, now, 10_000)).toBe(false);
  });
});
