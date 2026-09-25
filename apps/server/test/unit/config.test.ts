import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow();
  });

  it('applies defaults', () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x/y' });
    expect(config.PORT).toBe(3300);
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.SHIPYARD_VERSION).toBe('dev');
  });

  it('parses a supplied PORT as a number', () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x/y', PORT: '4000' });
    expect(config.PORT).toBe(4000);
  });

  it('rejects a non-positive PORT', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgresql://x/y', PORT: '0' })).toThrow();
  });

  it('carries through optional fields when set', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://x/y',
      PUBLIC_URL: 'https://shipyard.example',
      SESSION_SECRET: 'shh',
      SHIPYARD_VERSION: 'abc1234',
    });
    expect(config.PUBLIC_URL).toBe('https://shipyard.example');
    expect(config.SESSION_SECRET).toBe('shh');
    expect(config.SHIPYARD_VERSION).toBe('abc1234');
  });

  it('reads a blank numeric variable (KEY= in an env file) as unset, so the default applies', () => {
    const c = loadConfig({ DATABASE_URL: 'postgresql://x', PORT: '', BACKUP_RETENTION_DAYS: '', HEARTBEAT_STALE_MINUTES: ' ', BACKUP_DIR: '' });
    expect(c.PORT).toBe(3300);
    expect(c.BACKUP_RETENTION_DAYS).toBe(14);
    expect(c.HEARTBEAT_STALE_MINUTES).toBe(5);
    expect(c.BACKUP_DIR).toBe('/backups');
  });
});
