import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { confirmAgent, HostAdminError, issueToken } from '../../src/cli/host-admin.js';
import { createDb, type Db } from '../../src/db.js';
import { hashToken } from '../../src/tokens/tokens.js';

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) throw new Error('DATABASE_URL must be set for integration tests');
const db: Db = createDb(databaseUrl);

beforeEach(async () => {
  await db.$executeRawUnsafe('truncate table "audit_event", "api_token_app", "api_token", "app", "agent", "session", "user" cascade');
});
afterAll(async () => {
  await db.$disconnect();
});

async function seed(): Promise<{ agentId: string }> {
  const agent = await db.agent.create({ data: { publicKey: 'k', fingerprint: 'SHA256:abc' } });
  await db.user.create({ data: { email: 'op@example.com', displayName: 'Op', role: 'admin' } });
  await db.app.create({ data: { name: 'web', agentId: agent.id, manifestYaml: '{}', manifestSha256: '0'.repeat(64), reportedAt: new Date() } });
  return { agentId: agent.id };
}

describe('host-admin', () => {
  it('confirms an enrolled agent by fingerprint, audited, and refuses an unknown one', async () => {
    const { agentId } = await seed();
    await expect(confirmAgent(db, 'SHA256:nope')).rejects.toBeInstanceOf(HostAdminError);
    await confirmAgent(db, ' SHA256:abc ');
    expect((await db.agent.findUniqueOrThrow({ where: { id: agentId } })).confirmedAt).not.toBeNull();
    expect(await db.auditEvent.count({ where: { action: 'agent.confirmed', actorLabel: 'host-admin' } })).toBe(1);
  });

  it('issues a scoped token stored only as a hash, and refuses unreported apps', async () => {
    await seed();
    const issued = await issueToken(db, { email: 'OP@example.com', label: 'claude: web', apps: ['web'] });
    const row = await db.apiToken.findUniqueOrThrow({ where: { id: issued.id }, include: { apps: true } });
    expect(row.tokenHash).toBe(hashToken(issued.token));
    expect(row.apps).toHaveLength(1);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'token.created' } });
    expect(JSON.stringify(audit)).not.toContain(issued.token);
    await expect(issueToken(db, { email: 'op@example.com', label: 'x', apps: ['ghost'] })).rejects.toThrow(/not reported/);
    await expect(issueToken(db, { email: 'nobody@example.com', label: 'x', apps: ['web'] })).rejects.toThrow(/bootstrap-admin/);
  });
});
