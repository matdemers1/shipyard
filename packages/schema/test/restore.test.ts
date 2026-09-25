import { describe, expect, it } from 'vitest';

import { lossWindowText, RestoreRequest } from '../src/restore.js';

describe('lossWindowText', () => {
  it.each([
    [0, '0 seconds'],
    [1, '1 second'],
    [59, '59 seconds'],
    [60, '1 minute'],
    [3599, '59 minutes'],
    [3600, '1 hour'],
    [3 * 3600 + 12 * 60 + 5, '3 hours 12 minutes'],
    [86_400, '1 day'],
    [2 * 86_400 + 4 * 3600 + 30, '2 days 4 hours'],
    [-5, '0 seconds'],
  ])('%i seconds reads "%s"', (seconds, text) => {
    expect(lossWindowText(seconds)).toBe(text);
  });
});

describe('RestoreRequest', () => {
  it('carries a deploy ID and the typed name, never a path', () => {
    expect(RestoreRequest.safeParse({ backupDeployId: '3f0c1c1e-8a4b-4c1f-9a51-2f5d0b7c9e11', confirm: 'toy' }).success).toBe(true);
    expect(RestoreRequest.safeParse({ backupDeployId: '3f0c1c1e-8a4b-4c1f-9a51-2f5d0b7c9e11', confirm: 'toy', artifact: '/etc/passwd' }).success).toBe(false);
  });
});
