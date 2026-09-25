import { describe, expect, it } from 'vitest';

import { declaredEnv, missingEnv } from '../src/preflight.js';
import { LABEL_ENV } from '../src/types.js';

describe('declaredEnv', () => {
  it('is empty when the label is absent', () => {
    expect(declaredEnv({})).toEqual({ names: [], invalid: [] });
  });

  it('parses comma-separated names, trimming whitespace', () => {
    expect(declaredEnv({ [LABEL_ENV]: ' FOO, BAR ,BAZ ' })).toEqual({ names: ['FOO', 'BAR', 'BAZ'], invalid: [] });
  });

  it('ignores empty entries from stray commas', () => {
    expect(declaredEnv({ [LABEL_ENV]: 'FOO,,BAR,' })).toEqual({ names: ['FOO', 'BAR'], invalid: [] });
  });

  it('de-duplicates names, keeping first order', () => {
    expect(declaredEnv({ [LABEL_ENV]: 'FOO,BAR,FOO' })).toEqual({ names: ['FOO', 'BAR'], invalid: [] });
  });

  it('reports an entry that is not a valid identifier as invalid, not silently dropped', () => {
    expect(declaredEnv({ [LABEL_ENV]: 'FOO,1BAD,GOOD-NAME,BAR' })).toEqual({
      names: ['FOO', 'BAR'],
      invalid: ['1BAD', 'GOOD-NAME'],
    });
  });

  it('accepts a leading underscore and digits after the first character', () => {
    expect(declaredEnv({ [LABEL_ENV]: '_FOO,BAR2,BAZ_2' })).toEqual({ names: ['_FOO', 'BAR2', 'BAZ_2'], invalid: [] });
  });
});

describe('missingEnv', () => {
  it('returns nothing when every required name is present', () => {
    expect(missingEnv(['FOO', 'BAR'], ['FOO', 'BAR', 'BAZ'])).toEqual([]);
  });

  it('names every required entry absent from present, in required order', () => {
    expect(missingEnv(['FOO', 'BAR', 'BAZ'], ['BAR'])).toEqual(['FOO', 'BAZ']);
  });

  it('de-duplicates a required name listed twice', () => {
    expect(missingEnv(['FOO', 'FOO'], [])).toEqual(['FOO']);
  });

  it('returns nothing required against an empty list', () => {
    expect(missingEnv([], ['FOO'])).toEqual([]);
  });
});
