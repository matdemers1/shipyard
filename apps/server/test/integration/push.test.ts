// SHP-T-11.4 and SHP-T-11.5, the D3 App contract's push: a device registers its relay and key with a
// native session and gets one shipyard.registered notification only it can open; the registration
// goes with the session; a deploy held for approval reaches the phones of whoever may approve it.
import { createECDH, randomBytes, randomUUID, type ECDH } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { generateTotpSecret, hashPassword, totpCode } from '../../src/auth/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { openEnvelope } from '../../src/push/envelope.js';
import { signRelayRequest } from '../../src/push/relay.js';
import { generateToken } from '../../src/tokens/tokens.js';

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) throw new Error('DATABASE_URL must be set for integration tests');

const PASSWORD = 'correct horse battery staple';
const db: Db = createDb(databaseUrl);
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  PUBLIC_URL: 'https://shipyard.example.test',
  SESSION_SECRET: 'test-session-secret',
  RELAY_ALLOW_LOOPBACK_HTTP: '1',
});

interface Pushed {
  path: string;
  timestamp: string;
  signature: string;
  raw: string;
}

let app: Express;
let relay: Server;
let relayUrl = '';
let relayAnswer = 202;
const pushes: Pushed[] = [];
const used = new Map<string, number>();
const code = (secret: string): string => {
  const n = used.get(secret) ?? 0;
  used.set(secret, n + 1);
  return totpCode(secret, Date.now() + ([0, 30_000, -30_000][n % 3] ?? 0));
};

async function person(role: 'admin' | 'deployer' | 'viewer' = 'admin') {
  const secret = generateTotpSecret();
  const email = `push-${randomUUID()}@example.com`;
  const user = await db.user.create({ data: { email, displayName: 'Push', role, passwordHash: await hashPassword(PASSWORD), totpSecret: secret, totpEnabledAt: new Date() } });
  return { id: user.id, email, secret };
}
async function signIn(who: { email: string; secret: string }): Promise<{ accessToken: string; session: { id: string } }> {
  const first = await request(app).post('/api/auth/native/signin').send({ email: who.email, password: PASSWORD });
  const second = await request(app).post('/api/auth/native/signin').send({ challenge: (first.body as { challenge: string }).challenge, totp: code(who.secret) });
  expect(second.status).toBe(200);
  return second.body as { accessToken: string; session: { id: string } };
}
const device = (): ECDH => {
  const pair = createECDH('prime256v1');
  pair.generateKeys();
  return pair;
};
const register = (token: string, key: ECDH, registration: string, categories: string[] = [], url = relayUrl) =>
  request(app)
    .post('/api/push/native/register')
    .set('Authorization', `Bearer ${token}`)
    .send({ devicePublicKey: key.getPublicKey().toString('base64'), relay: { url, registration, sendKey: `send-key-${registration}-0123456789` }, categories });
async function pushTo(registration: string): Promise<Pushed> {
  for (let i = 0; i < 80; i++) {
    const found = pushes.find((p) => p.path === `/v1/push/${registration}`);
    if (found !== undefined) return found;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no push for ${registration}`);
}
const payloadOf = (key: ECDH, pushed: Pushed) =>
  JSON.parse(openEnvelope(key, (JSON.parse(pushed.raw) as { ciphertext: string }).ciphertext).toString()) as Record<string, unknown>;

beforeAll(async () => {
  relay = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      pushes.push({ path: req.url ?? '', timestamp: String(req.headers['x-d3-relay-timestamp']), signature: String(req.headers['x-d3-relay-signature']), raw });
      res.writeHead(relayAnswer, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', () => { resolve(); }));
  relayUrl = `http://127.0.0.1:${String((relay.address() as AddressInfo).port)}`;
  app = createApp({ db, logger: pino({ enabled: false }), config, oidc: null });
});

afterAll(async () => {
  relay.close();
  await db.$disconnect();
});

describe('relay registration (SHP-T-11.4)', () => {
  it('the manifest names the endpoint', async () => {
    const res = await request(app).get('/.well-known/d3-app.json');
    expect((res.body as { endpoints: Record<string, string> }).endpoints['relayRegister']).toBe('https://shipyard.example.test/api/push/native/register');
  });

  it('registers, then sends one shipyard.registered notification only this device can open', async () => {
    const who = await person();
    const tokens = await signIn(who);
    const key = device();
    const reg = `reg-${randomUUID()}`;
    expect((await register(tokens.accessToken, key, reg)).status).toBe(204);
    const pushed = await pushTo(reg);
    expect(pushed.signature).toBe(signRelayRequest(`send-key-${reg}-0123456789`, pushed.timestamp, pushed.raw));
    expect(payloadOf(key, pushed)).toMatchObject({ v: 1, category: 'shipyard.registered', title: 'Notifications are on' });
    const row = await db.relayRegistration.findFirstOrThrow({ where: { registration: reg } });
    expect(row.sessionId).toBe(tokens.session.id);
    expect(row.sendKeySealed).not.toContain('send-key');
  });

  it('refuses a missing relay, a bad key, plain http off loopback, an API token and the console cookie', async () => {
    const who = await person();
    const tokens = await signIn(who);
    const key = device();
    const noRelay = await request(app).post('/api/push/native/register').set('Authorization', `Bearer ${tokens.accessToken}`).send({ devicePublicKey: key.getPublicKey().toString('base64'), apnsToken: 'ab'.repeat(32) });
    expect(noRelay.status).toBe(400);
    const badKey = await request(app).post('/api/push/native/register').set('Authorization', `Bearer ${tokens.accessToken}`).send({ devicePublicKey: Buffer.alloc(65, 4).toString('base64'), relay: { url: relayUrl, registration: 'x', sendKey: 'send-key-0123456789' }, categories: [] });
    expect(badKey.status).toBe(400);
    expect((await register(tokens.accessToken, key, 'plain', [], 'http://relay.example.com')).status).toBe(400);
    const { token, hash, prefix } = generateToken();
    await db.apiToken.create({ data: { userId: who.id, label: `t-${randomBytes(3).toString('hex')}`, tokenHash: hash, prefix } });
    expect((await register(token, key, 'api-token')).status).toBe(401);
  });

  it('registering again replaces; revoking the session forgets the registration; a 410 forgets it too', async () => {
    const who = await person();
    const tokens = await signIn(who);
    const key = device();
    await register(tokens.accessToken, key, `a-${tokens.session.id}`);
    await register(tokens.accessToken, key, `b-${tokens.session.id}`);
    expect(await db.relayRegistration.count({ where: { sessionId: tokens.session.id } })).toBe(1);
    expect((await request(app).post('/api/auth/native/revoke').set('Authorization', `Bearer ${tokens.accessToken}`)).status).toBe(204);
    expect(await db.relayRegistration.count({ where: { registration: { in: [`a-${tokens.session.id}`, `b-${tokens.session.id}`] } } })).toBe(0);

    const again = await signIn(who);
    relayAnswer = 410;
    try {
      const reg = `gone-${again.session.id}`;
      await register(again.accessToken, key, reg);
      await pushTo(reg);
      for (let i = 0; i < 40 && (await db.relayRegistration.count({ where: { registration: reg } })) > 0; i++) await new Promise((r) => setTimeout(r, 25));
      expect(await db.relayRegistration.count({ where: { registration: reg } })).toBe(0);
    } finally {
      relayAnswer = 202;
    }
  });
});

describe('a deploy waiting for approval (SHP-T-11.5)', () => {
  it('reaches the phones of whoever may approve it, and not a viewer’s', async () => {
    const approver = await person('admin');
    const viewer = await person('viewer');
    const approverKey = device();
    const viewerKey = device();
    const a = await signIn(approver);
    const v = await signIn(viewer);
    const approverReg = `approve-${a.session.id}`;
    const viewerReg = `view-${v.session.id}`;
    await register(a.accessToken, approverKey, approverReg, ['shipyard.approval']);
    await register(v.accessToken, viewerKey, viewerReg, ['shipyard.approval']);

    const name = `push-${randomBytes(3).toString('hex')}`;
    const agent = await db.agent.create({ data: { publicKey: 'test-key', fingerprint: `fp-${randomUUID()}` } });
    const row = await db.app.create({
      data: { name, agentId: agent.id, manifestYaml: `name: ${name}\napproval: required\n`, manifestSha256: '0'.repeat(64), repo: `matdemers1/${name}`, defaultBranch: 'main', reportedAt: new Date(), approvalPolicy: 'required' },
    });
    const deployer = await db.user.create({ data: { email: `deployer-${randomUUID()}@example.com`, displayName: 'claude', role: 'deployer' } });
    const { token, hash, prefix } = generateToken();
    await db.apiToken.create({ data: { userId: deployer.id, label: `claude-${name}`, tokenHash: hash, prefix, apps: { create: [{ appId: row.id }] } } });
    const sha = 'c'.repeat(40);
    const held = await request(app).post('/api/deploys').set('Authorization', `Bearer ${token}`).send({ kind: 'deploy', app: name, sha, requester: { repo: `matdemers1/${name}`, branch: 'main', label: 'claude: test' } });
    expect(held.status).toBe(201);
    expect((held.body as { state: string }).state).toBe('awaiting_approval');

    let pushed: Pushed | undefined;
    for (let i = 0; i < 80 && pushed === undefined; i++) {
      pushed = pushes.find((p) => p.path === `/v1/push/${approverReg}` && payloadOf(approverKey, p)['category'] === 'shipyard.approval');
      if (pushed === undefined) await new Promise((r) => setTimeout(r, 25));
    }
    if (pushed === undefined) throw new Error('no approval push');
    expect(payloadOf(approverKey, pushed)).toMatchObject({
      category: 'shipyard.approval',
      title: `${name} is waiting for you`,
      body: 'Approve ccccccc to go live.',
      link: 'd3constellation://shipyard.example.test/shipyard',
    });
    expect((JSON.parse(pushed.raw) as { collapseId: string }).collapseId).toBe((held.body as { deployId: string }).deployId);
    await new Promise((r) => setTimeout(r, 200));
    expect(pushes.some((p) => p.path === `/v1/push/${viewerReg}` && payloadOf(viewerKey, p)['category'] === 'shipyard.approval')).toBe(false);
  });
});
