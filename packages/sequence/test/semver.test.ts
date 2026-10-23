import { describe, expect, it } from 'vitest';

import { parseSemverRange, parseTagVersion, pickSemverTag, SemverRangeError } from '../src/semver.js';

// SHP-REQ-194: a `{ semver }` track follows the highest registry tag inside its range.

const POSTGRES = ['latest', '16', '16.4', '16.4-alpine', '17', '17.0', '17.1', '17.2', '17.2-alpine', '17.2-bookworm', '17.3-rc1', '18beta1', '18.0-beta1'];

describe('parseTagVersion', () => {
  it('reads one to three numeric parts, a v prefix and a pre-release', () => {
    expect(parseTagVersion('17')).toEqual({ major: 17, minor: 0, patch: 0, pre: [], parts: 1 });
    expect(parseTagVersion('v1.4.2')).toEqual({ major: 1, minor: 4, patch: 2, pre: [], parts: 3 });
    expect(parseTagVersion('2.0.0-rc.1')).toEqual({ major: 2, minor: 0, patch: 0, pre: ['rc', '1'], parts: 3 });
  });

  it('is not a version for anything else', () => {
    for (const tag of ['latest', 'stable', '4.0.11.2680-ls262', '01.2', '1..2', '18beta1', '']) expect(parseTagVersion(tag), tag).toBeNull();
  });
});

describe('pickSemverTag', () => {
  it('17.x picks the highest 17 release and ignores suffixed and pre-release tags', () => {
    expect(pickSemverTag(POSTGRES, '17.x')).toBe('17.2');
    expect(pickSemverTag(POSTGRES, '17')).toBe('17.2');
    expect(pickSemverTag(POSTGRES, '17.X')).toBe('17.2');
  });

  it('17.1.x and 17.1 stay inside the minor', () => {
    const tags = ['17.1.0', '17.1.4', '17.2.0', '17.1.5-rc1'];
    expect(pickSemverTag(tags, '17.1.x')).toBe('17.1.4');
    expect(pickSemverTag(tags, '17.1')).toBe('17.1.4');
  });

  it('^1.4 allows minors and patches, never the next major', () => {
    const tags = ['1.3.9', '1.4.0', '1.4.7', '1.9.2', '2.0.0', '1.10.0-beta.1'];
    expect(pickSemverTag(tags, '^1.4')).toBe('1.9.2');
    expect(pickSemverTag(tags, '^1.4.7')).toBe('1.9.2');
    expect(pickSemverTag(tags, '^1.10')).toBeNull();
  });

  it('^0.x ranges are narrower, as npm reads them', () => {
    const tags = ['0.2.3', '0.2.9', '0.3.0', '0.0.3', '0.0.4'];
    expect(pickSemverTag(tags, '^0.2.3')).toBe('0.2.9');
    expect(pickSemverTag(tags, '^0.0.3')).toBe('0.0.3');
  });

  it('~1.4.2 allows patches only', () => {
    const tags = ['1.4.1', '1.4.2', '1.4.8', '1.5.0'];
    expect(pickSemverTag(tags, '~1.4.2')).toBe('1.4.8');
    expect(pickSemverTag(tags, '~1')).toBe('1.5.0');
  });

  it('a plain full version is exact', () => {
    expect(pickSemverTag(['1.4.2', '1.4.3', 'v1.4.2'], '1.4.2')).toBe('1.4.2');
  });

  it('comparators, conjunctions and alternatives', () => {
    const tags = ['1.0.0', '1.5.0', '2.0.0', '2.3.1', '3.0.0'];
    expect(pickSemverTag(tags, '>=1.2 <2')).toBe('1.5.0');
    expect(pickSemverTag(tags, '>= 1.2 < 2')).toBe('1.5.0');
    expect(pickSemverTag(tags, '<=2.3')).toBe('2.3.1');
    expect(pickSemverTag(tags, '>2.3.1')).toBe('3.0.0');
    expect(pickSemverTag(tags, '1.x || 2.x')).toBe('2.3.1');
    expect(pickSemverTag(tags, '*')).toBe('3.0.0');
    expect(pickSemverTag(tags, '<1')).toBeNull();
  });

  it('ignores pre-releases unless the range names one of the same version', () => {
    const tags = ['1.0.0-1', '1.0.0-2', '0.9.0'];
    expect(pickSemverTag(tags, '^0.9 || ^1')).toBe('0.9.0');
    expect(pickSemverTag(tags, '>=1.0.0-1')).toBe('1.0.0-2');
  });

  it('prefers the more specific of two tags naming one version', () => {
    expect(pickSemverTag(['17.2', '17.2.0'], '17.x')).toBe('17.2.0');
    expect(pickSemverTag(['v2.1.0', '2.1.0'], '^2')).toBe('2.1.0');
  });

  it('no tag in range is null; an unreadable range throws', () => {
    expect(pickSemverTag(['latest', 'edge'], '17.x')).toBeNull();
    expect(() => parseSemverRange('17..x')).toThrow(SemverRangeError);
    expect(() => parseSemverRange('   ')).toThrow(SemverRangeError);
  });
});
