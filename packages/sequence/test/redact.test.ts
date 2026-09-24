import { describe, expect, it } from 'vitest';

import { loadSecrets, parseEnvFile, redact } from '../src/redact.js';
import type { FsPort } from '../src/ports.js';

function fakeFs(files: Record<string, string>): FsPort {
  return {
    readFile: (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return Promise.resolve(content);
    },
    writeFileAtomic: () => Promise.resolve(),
    appendLine: () => Promise.resolve(),
    exists: (path) => Promise.resolve(path in files),
    mkdirp: () => Promise.resolve(),
    list: () => Promise.resolve([]),
  };
}

describe('parseEnvFile', () => {
  it('parses KEY=value pairs', () => {
    const parsed = parseEnvFile('DB_PASSWORD=hunter2\nAPI_KEY=abc123def\n');
    expect(parsed.get('DB_PASSWORD')).toBe('hunter2');
    expect(parsed.get('API_KEY')).toBe('abc123def');
  });

  it('handles export prefix', () => {
    const parsed = parseEnvFile('export DB_PASSWORD=hunter2');
    expect(parsed.get('DB_PASSWORD')).toBe('hunter2');
  });

  it('strips matching quotes', () => {
    const parsed = parseEnvFile(`DOUBLE="quoted value"\nSINGLE='other value'\n`);
    expect(parsed.get('DOUBLE')).toBe('quoted value');
    expect(parsed.get('SINGLE')).toBe('other value');
  });

  it('skips blank lines and comments', () => {
    const parsed = parseEnvFile('\n# a comment\n\nKEY=value\n  # indented comment\n');
    expect(parsed.size).toBe(1);
    expect(parsed.get('KEY')).toBe('value');
  });

  it('skips lines without an equals sign', () => {
    const parsed = parseEnvFile('not-a-line\nKEY=value');
    expect(parsed.size).toBe(1);
  });

  it('handles an empty value', () => {
    const parsed = parseEnvFile('EMPTY=');
    expect(parsed.get('EMPTY')).toBe('');
  });
});

describe('loadSecrets', () => {
  it('merges entries across multiple files', async () => {
    const fs = fakeFs({
      '/env/one': 'DB_PASSWORD=hunter2',
      '/env/two': 'API_KEY=abc123def',
    });
    const secrets = await loadSecrets(fs, ['/env/one', '/env/two']);
    expect(secrets.get('DB_PASSWORD')).toBe('hunter2');
    expect(secrets.get('API_KEY')).toBe('abc123def');
  });

  it('errors naming a missing file', async () => {
    const fs = fakeFs({ '/env/one': 'DB_PASSWORD=hunter2' });
    await expect(loadSecrets(fs, ['/env/one', '/env/missing'])).rejects.toThrow('/env/missing');
  });

  it('returns an empty map when no env files are declared', async () => {
    const fs = fakeFs({});
    const secrets = await loadSecrets(fs, undefined);
    expect(secrets.size).toBe(0);
  });
});

describe('redact', () => {
  it('replaces a secret value with its redacted name', () => {
    const secrets = new Map([['DB_PASSWORD', 'hunter2']]);
    const output = redact('connecting with hunter2 now', secrets);
    expect(output).toContain('«redacted:DB_PASSWORD»');
    expect(output).not.toContain('hunter2');
  });

  it('replaces every occurrence', () => {
    const secrets = new Map([['TOKEN', 'sekrit123']]);
    const output = redact('sekrit123 and again sekrit123', secrets);
    expect(output.match(/«redacted:TOKEN»/g)).toHaveLength(2);
    expect(output).not.toContain('sekrit123');
  });

  it('skips values shorter than 4 characters', () => {
    const secrets = new Map([['SHORT', 'abc']]);
    const output = redact('value is abc here', secrets);
    expect(output).toContain('abc');
    expect(output).not.toContain('«redacted:SHORT»');
  });

  it('skips true/false and short digit-only values', () => {
    const secrets = new Map([
      ['FLAG', 'true'],
      ['OTHER_FLAG', 'false'],
      ['PORT', '8080'],
    ]);
    const output = redact('true false 8080', secrets);
    expect(output).toBe('true false 8080');
  });

  it('does not skip a long digit-only value', () => {
    const secrets = new Map([['PIN', '123456']]);
    const output = redact('the pin is 123456', secrets);
    expect(output).toContain('«redacted:PIN»');
  });

  it('replaces longest values first to avoid partial-overlap corruption', () => {
    const secrets = new Map([
      ['SHORT_SECRET', 'sekrit'],
      ['LONG_SECRET', 'sekrit-extended'],
    ]);
    const output = redact('token=sekrit-extended', secrets);
    expect(output).toBe('token=«redacted:LONG_SECRET»');
  });

  it('keeps only the last 50 lines', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${String(i)}`);
    const output = redact(lines.join('\n'), new Map());
    const outLines = output.split('\n');
    expect(outLines).toHaveLength(50);
    expect(outLines[0]).toBe('line 10');
    expect(outLines[49]).toBe('line 59');
  });
});
