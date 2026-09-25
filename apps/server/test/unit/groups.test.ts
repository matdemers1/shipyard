import { describe, expect, it } from 'vitest';
import { groupState, orderMembers, readGroupMeta } from '../../src/groups/service.js';

describe('group deploy order and state (SHP-REQ-078, SHP-REQ-079)', () => {
  it('orders the canary first, then the rest by app name', () => {
    const ordered = orderMembers([
      { name: 'foreman', canary: false },
      { name: 'foreman-mcp', canary: false },
      { name: 'foreman-board', canary: true },
      { name: 'alpha', canary: false },
    ]);
    expect(ordered.map((m) => m.name)).toEqual(['foreman-board', 'alpha', 'foreman', 'foreman-mcp']);
  });

  it('a group is as far as its first member that has not succeeded', () => {
    expect(groupState([{ state: 'succeeded' }, { state: 'soaking' }, { state: 'locked' }])).toBe('soaking');
    expect(groupState([{ state: 'succeeded' }, { state: 'failed' }, { state: 'cancelled' }])).toBe('failed');
    expect(groupState([{ state: 'succeeded' }, { state: 'succeeded' }])).toBe('succeeded');
  });

  it('reads a member\'s place in its group from its result, and nothing from anything else', () => {
    expect(readGroupMeta({ group: { name: 'g', position: 0, canary: true }, gates: [] })).toEqual({ name: 'g', position: 0, canary: true });
    expect(readGroupMeta({ gates: [] })).toBeNull();
    expect(readGroupMeta(null)).toBeNull();
    expect(readGroupMeta({ group: { name: 'g', position: '0', canary: true } })).toBeNull();
  });
});
