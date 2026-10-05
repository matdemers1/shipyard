// The D3 App contract's conformance suite needs a running Shipyard and an account it can sign in to
// (SHP-T-10.4). This boots the server on DATABASE_URL (already migrated) with its only admin, an
// invite and a disposable account to delete (SHP-T-11.2, SHP-T-11.3), each generated here, and writes
// the suite's arguments to CONFORMANCE_OUT:
//
//   DATABASE_URL=… CONFORMANCE_OUT=/tmp/args.json node --import tsx test/conformance-server.ts
//
// Plain http on 127.0.0.1, so the suite runs with --allow-http — for CI and a laptop, never a host.
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import pino from 'pino';
import { createApp } from '../src/app.js';
import { generateTotpSecret, hashPassword } from '../src/auth/index.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { hashInviteToken } from '../src/users/index.js';

const url = process.env['DATABASE_URL'];
const out = process.env['CONFORMANCE_OUT'];
const port = Number(process.env['PORT'] ?? '3478');
if (url === undefined || out === undefined) {
  process.stderr.write('DATABASE_URL and CONFORMANCE_OUT are required\n');
  process.exit(2);
}

const origin = `http://127.0.0.1:${String(port)}`;
const db = createDb(url);
const password = `conformance ${randomBytes(6).toString('hex')} staple`;
const totpSecret = generateTotpSecret();
const email = `conformance-${randomBytes(4).toString('hex')}@example.com`;
// The instance's only admin, so the suite's last-owner check has something to refuse.
const admin = await db.user.create({
  data: { email, displayName: 'Conformance', role: 'admin', passwordHash: await hashPassword(password), totpSecret, totpEnabledAt: new Date() },
});
const deleteEmail = `conformance-delete-${randomBytes(4).toString('hex')}@example.com`;
const deleteTotpSecret = generateTotpSecret();
await db.user.create({
  data: { email: deleteEmail, displayName: 'Disposable', role: 'deployer', passwordHash: await hashPassword(password), totpSecret: deleteTotpSecret, totpEnabledAt: new Date() },
});
const inviteToken = `inv_${randomBytes(32).toString('base64url')}`;
await db.invite.create({
  data: {
    email: `conformance-invite-${randomBytes(4).toString('hex')}@example.com`,
    role: 'viewer',
    tokenHash: hashInviteToken(inviteToken),
    invitedById: admin.id,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  },
});
const config = loadConfig({ DATABASE_URL: url, PUBLIC_URL: origin, SESSION_SECRET: randomBytes(32).toString('hex'), RELAY_ALLOW_LOOPBACK_HTTP: '1' });
const app = createApp({ db, logger: pino({ enabled: false }), config, oidc: null });

const server = app.listen(port, '127.0.0.1', () => {
  writeFileSync(out, `${JSON.stringify({
    base: origin, product: 'shipyard', email, password, totpSecret,
    inviteToken, deleteEmail, deletePassword: password, deleteTotpSecret,
  })}\n`, { mode: 0o600 });
  process.stdout.write(`conformance server on ${origin}\n`);
});
const stop = (): void => {
  server.close();
  void db.$disconnect().finally(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
