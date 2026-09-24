import { describe, expect, it } from 'vitest';

import { ACTIVE_STATES } from '../src/agent.js';

describe('ACTIVE_STATES', () => {
  it('has exactly the nine states between locked and rolling_back', () => {
    expect(ACTIVE_STATES).toEqual([
      'locked',
      'verifying',
      'backing_up',
      'migrating',
      'pulling',
      'swapping',
      'checking',
      'soaking',
      'rolling_back',
    ]);
    expect(ACTIVE_STATES).toHaveLength(9);
  });
});
