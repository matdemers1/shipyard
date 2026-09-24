import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { parseManifestYaml } from '../src/manifest.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('parseManifestYaml', () => {
  it('parses a valid manifest from YAML text', () => {
    const text = readFileSync(join(here, 'fixtures/manifest/valid/basic.yaml'), 'utf-8');
    const manifest = parseManifestYaml(text);
    expect(manifest.name).toBe('bindery');
    expect(manifest.services.server?.image).toBe('ghcr.io/matdemers1/bindery/server');
  });

  it('throws a ZodError for a manifest with a shell command step', () => {
    const text = readFileSync(join(here, 'fixtures/manifest/invalid/step-command-string.yaml'), 'utf-8');
    expect(() => parseManifestYaml(text)).toThrow(ZodError);
  });

  it('throws (not a ZodError) for malformed YAML', () => {
    expect(() => parseManifestYaml('name: [unterminated')).toThrow();
    try {
      parseManifestYaml('name: [unterminated');
      expect.unreachable('expected a parse error');
    } catch (error) {
      expect(error).not.toBeInstanceOf(ZodError);
    }
  });
});
