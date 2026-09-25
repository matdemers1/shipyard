import { describe, expect, it } from 'vitest';

import { parseArgs } from '../src/args.js';

const GOOD_APP = 'toy';
const GOOD_SHA = 'a'.repeat(40);

describe('parseArgs', () => {
  it('no argv is the help command', () => {
    const result = parseArgs([]);
    expect(result).toEqual({ ok: true, command: { kind: 'help' } });
  });

  it('--help is the help command', () => {
    expect(parseArgs(['--help'])).toEqual({ ok: true, command: { kind: 'help' } });
  });

  it('parses a full deploy invocation', () => {
    const result = parseArgs(['deploy', GOOD_APP, GOOD_SHA, '--dry-run', '--label', 'someone', '--json']);
    expect(result).toEqual({
      ok: true,
      command: { kind: 'deploy', app: GOOD_APP, sha: GOOD_SHA, dryRun: true, label: 'someone', json: true },
    });
  });

  it('defaults dry-run/json to false and label to undefined', () => {
    const result = parseArgs(['deploy', GOOD_APP, GOOD_SHA]);
    expect(result).toEqual({ ok: true, command: { kind: 'deploy', app: GOOD_APP, sha: GOOD_SHA, dryRun: false, label: undefined, json: false } });
  });

  it('refuses an invalid app name', () => {
    const result = parseArgs(['deploy', 'NOT_VALID', GOOD_SHA]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('invalid app');
  });

  it('refuses a sha that is not 40 lowercase hex characters', () => {
    const result = parseArgs(['deploy', GOOD_APP, 'not-a-sha']);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('invalid sha');
  });

  it('refuses an uppercase sha (must be lowercase hex)', () => {
    const result = parseArgs(['deploy', GOOD_APP, 'A'.repeat(40)]);
    expect(result.ok).toBe(false);
  });

  it('refuses too few positional args', () => {
    const result = parseArgs(['deploy', GOOD_APP]);
    expect(result.ok).toBe(false);
  });

  it('refuses too many positional args', () => {
    const result = parseArgs(['deploy', GOOD_APP, GOOD_SHA, 'extra']);
    expect(result.ok).toBe(false);
  });

  it('refuses an unknown option', () => {
    const result = parseArgs(['deploy', GOOD_APP, GOOD_SHA, '--bogus']);
    expect(result.ok).toBe(false);
  });

  it('refuses --label with no value', () => {
    const result = parseArgs(['deploy', GOOD_APP, GOOD_SHA, '--label']);
    expect(result.ok).toBe(false);
  });

  it('parses status', () => {
    expect(parseArgs(['status', GOOD_APP])).toEqual({ ok: true, command: { kind: 'status', app: GOOD_APP } });
  });

  it('refuses status with a bad app name', () => {
    expect(parseArgs(['status', 'Bad Name']).ok).toBe(false);
  });

  it('refuses status with no app', () => {
    expect(parseArgs(['status']).ok).toBe(false);
  });

  it('parses recover with no arguments', () => {
    expect(parseArgs(['recover'])).toEqual({ ok: true, command: { kind: 'recover' } });
  });

  it('refuses recover with extra arguments', () => {
    expect(parseArgs(['recover', 'extra']).ok).toBe(false);
  });

  it('parses check-manifests with no arguments', () => {
    expect(parseArgs(['check-manifests'])).toEqual({ ok: true, command: { kind: 'check-manifests' } });
  });

  it('refuses an unknown command', () => {
    const result = parseArgs(['launch-the-missiles']);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('unknown command');
  });
});
