import { describe, expect, it } from 'vitest';

import { CATALOGUE, ErrorCode, refusal } from '../src/errors.js';

describe('refusal()', () => {
  it('fills gate and the default fix from the catalogue', () => {
    const r = refusal('locked', 'Another deploy is in progress for bindery.');
    expect(r).toEqual({
      code: 'locked',
      gate: CATALOGUE.locked.gate,
      message: 'Another deploy is in progress for bindery.',
      fix: CATALOGUE.locked.defaultFix,
    });
  });

  it('accepts an overriding fix', () => {
    const r = refusal('locked', 'msg', 'custom fix');
    expect(r.fix).toBe('custom fix');
    expect(r.gate).toBe(CATALOGUE.locked.gate);
  });

  it('has a catalogue entry for every ErrorCode', () => {
    for (const code of ErrorCode.options) {
      expect(CATALOGUE[code]).toBeDefined();
      expect(CATALOGUE[code].defaultFix.length).toBeGreaterThan(0);
    }
  });
});
