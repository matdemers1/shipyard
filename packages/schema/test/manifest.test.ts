import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { Manifest, parseManifestYaml } from '../src/manifest.js';

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

describe('service image', () => {
  const base = {
    name: 'toy', repo: 'example/toy', workflow: 'ci.yml',
    compose: { files: ['/srv/toy/compose.yml'], project: 'toy' },
    health: { service: 'app', port: 3000, path: '/health' },
  };
  it('accepts a registry with a port', () => {
    expect(Manifest.safeParse({ ...base, services: { app: { image: 'registry:5000/toy/app' } } }).success).toBe(true);
  });
  it('rejects a tag or a digest', () => {
    expect(Manifest.safeParse({ ...base, services: { app: { image: 'registry:5000/toy/app:latest' } } }).success).toBe(false);
    expect(Manifest.safeParse({ ...base, services: { app: { image: 'ghcr.io/a/b@sha256:' + 'a'.repeat(64) } } }).success).toBe(false);
  });
});

describe('steps.restore (SHP-T-5.6)', () => {
  const base = {
    name: 'toy', repo: 'example/toy', workflow: 'ci.yml',
    compose: { files: ['/srv/toy/compose.yml'], project: 'toy' },
    services: { app: { image: 'ghcr.io/example/toy/app' } },
    health: { service: 'app', port: 3000, path: '/health' },
  };
  const backup = { service: 'db', argv: ['pg_dump', '-f', '/backups/x.dump'], artifactsDir: '/srv/toy/backups' };

  it('accepts a restore argv naming {artifact}, beside a backup step', () => {
    const parsed = Manifest.parse({ ...base, steps: { backup, restore: { service: 'db', argv: ['pg_restore', '/backups/{artifact}'] } } });
    expect(parsed.steps?.restore?.argv).toEqual(['pg_restore', '/backups/{artifact}']);
  });

  it('refuses a restore without a backup step, naming steps.restore', () => {
    const result = Manifest.safeParse({ ...base, steps: { restore: { service: 'db', argv: ['pg_restore', '/backups/{artifact}'] } } });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.path.join('.') === 'steps.restore' && i.message.includes('steps.backup'))).toBe(true);
  });

  it('refuses a restore argv that never names {artifact}', () => {
    const result = Manifest.safeParse({ ...base, steps: { backup, restore: { service: 'db', argv: ['pg_restore', '/backups/latest.dump'] } } });
    expect(result.success).toBe(false);
  });

  it('refuses a command string and unknown keys on the restore step', () => {
    expect(Manifest.safeParse({ ...base, steps: { backup, restore: { service: 'db', argv: 'pg_restore /backups/{artifact}' } } }).success).toBe(false);
    expect(Manifest.safeParse({ ...base, steps: { backup, restore: { service: 'db', argv: ['x', '{artifact}'], shell: true } } }).success).toBe(false);
  });
});
