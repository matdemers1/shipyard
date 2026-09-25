import { join } from 'node:path';

/**
 * Everything the harness agrees on: where the server listens, which database it owns, who can sign
 * in and with which TOTP secret. The seeded secrets are fixed so a failing run can be reproduced by
 * hand — they exist only in a `_test` database the harness wipes on every run.
 */

export const PORT = Number(process.env['SHIPYARD_PORT'] ?? '3462');
export const BASE_URL = process.env['SHIPYARD_URL'] ?? `http://127.0.0.1:${String(PORT)}`;

/** The harness wipes this database. It must be a dedicated test database (the name ends in `_test`). */
export function databaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error('console-e2e needs DATABASE_URL, pointing at a dedicated PostgreSQL 16 database whose name ends in _test');
  }
  const name = new URL(url).pathname.slice(1);
  if (!name.endsWith('_test')) {
    throw new Error(`refusing to run console-e2e against "${name}": it wipes the database, so the name must end in _test`);
  }
  return url;
}

export const ROOT = join(import.meta.dirname, '..');
/** Per-role signed-in browser state and the seeded IDs, written by global setup. */
export const STATE_DIR = join(ROOT, '.state');
export const FIXTURE_FILE = join(STATE_DIR, 'fixture.json');

export type RoleName = 'admin' | 'viewer';

export interface SeedUser {
  email: string;
  displayName: string;
  password: string;
  /** Base32, as `user.totp_secret` stores it. */
  totpSecret: string;
  role: 'admin' | 'viewer';
}

export const USERS: Record<RoleName, SeedUser> = {
  admin: {
    email: 'admin@shipyard.test',
    displayName: 'Ada Admin',
    password: 'console-e2e-admin-password',
    totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
    role: 'admin',
  },
  viewer: {
    email: 'viewer@shipyard.test',
    displayName: 'Vic Viewer',
    password: 'console-e2e-viewer-password',
    totpSecret: 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU',
    role: 'viewer',
  },
};

export function storageStateFor(role: RoleName): string {
  return join(STATE_DIR, `${role}.json`);
}

/**
 * The plaintext of the seeded pending invite (`inv_` and 43 base64url characters, the shape the
 * server issues); the database holds only its sha256.
 */
export const INVITE_TOKEN = 'inv_consoleE2eInviteToken0123456789abcdefghijkl';
