import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { checkHeartbeat } from '../../src/jobs/heartbeat.js';
import type { Mailer, MailResult, Alert } from '../../src/mail/index.js';
import type { Db } from '../../src/db.js';
import type { ServiceDeps } from '../../src/deps.js';
import { loadConfig } from '../../src/config.js';

interface FakeAgentRow {
  id: string;
  fingerprint: string;
  confirmedAt: Date | null;
  lastHeartbeatAt: Date | null;
}

interface FakeAuditRow {
  action: string;
  entityType: string;
  entityId: string | null;
  at: Date;
  after: unknown;
}

/** Just enough of `Db` for `checkHeartbeat`: one agent, and an in-memory audit log. */
function fakeDb(agent: FakeAgentRow | null): { db: Db; audit: FakeAuditRow[] } {
  const audit: FakeAuditRow[] = [];
  const db = {
    agent: {
      findFirst: (_args: { where: { confirmedAt: { not: null } } }) =>
        Promise.resolve(agent !== null && agent.confirmedAt !== null ? agent : null),
    },
    auditEvent: {
      findFirst: (args: {
        where: { action: string; entityType: string; entityId: string; at: { gt: Date } };
        orderBy: unknown;
        select: unknown;
      }) => {
        const matches = audit
          .filter(
            (row) =>
              row.action === args.where.action &&
              row.entityType === args.where.entityType &&
              row.entityId === args.where.entityId &&
              row.at.getTime() > args.where.at.gt.getTime(),
          )
          .sort((a, b) => b.at.getTime() - a.at.getTime());
        return Promise.resolve(matches[0] === undefined ? null : { after: matches[0].after });
      },
      create: (args: { data: { action: string; entityType: string; entityId?: string; after?: unknown } }) => {
        audit.push({
          action: args.data.action,
          entityType: args.data.entityType,
          entityId: args.data.entityId ?? null,
          at: new Date(),
          after: args.data.after,
        });
        return Promise.resolve({});
      },
    },
  };
  return { db: db as unknown as Db, audit };
}

function fakeMailer(): { mailer: Mailer; sent: Alert[] } {
  const sent: Alert[] = [];
  const mailer: Mailer = {
    send(alert: Alert): Promise<MailResult> {
      sent.push(alert);
      return Promise.resolve({ sent: true });
    },
  };
  return { mailer, sent };
}

function deps(db: Db): ServiceDeps {
  const config = loadConfig({ DATABASE_URL: 'postgresql://x/y', HEARTBEAT_STALE_MINUTES: '5' });
  return { db, logger: pino({ enabled: false }), config, bus: { publish: () => undefined } as never };
}

const AGENT_ID = 'agent-1';
const FINGERPRINT = 'SHA256:abc';

describe('checkHeartbeat (SHP-T-6.4, SHP-REQ-093)', () => {
  it('sends no alert when there is no confirmed agent', async () => {
    const { db } = fakeDb(null);
    const { mailer, sent } = fakeMailer();
    const state = { alerted: false };
    await checkHeartbeat(deps(db), mailer, state, new Date('2026-09-25T00:10:00.000Z'));
    expect(sent).toHaveLength(0);
  });

  it('sends exactly one email across many stale ticks, then a second only after recovery and staling again', async () => {
    let lastHeartbeatAt: Date | null = new Date('2026-09-25T00:00:00.000Z');
    const { db } = fakeDb({ id: AGENT_ID, fingerprint: FINGERPRINT, confirmedAt: new Date('2026-09-24T00:00:00.000Z'), lastHeartbeatAt: null });
    // Override agent.findFirst to read the mutable lastHeartbeatAt.
    (db as unknown as { agent: { findFirst: () => Promise<FakeAgentRow | null> } }).agent.findFirst = () =>
      Promise.resolve({ id: AGENT_ID, fingerprint: FINGERPRINT, confirmedAt: new Date(), lastHeartbeatAt });

    const { mailer, sent } = fakeMailer();
    const d = deps(db);
    const state = { alerted: false };

    // Stale from the start (agent went quiet at 00:00, threshold is 5 minutes).
    await checkHeartbeat(d, mailer, state, new Date('2026-09-25T00:10:00.000Z'));
    expect(sent).toHaveLength(1);

    // Many more ticks while still stale: no more sends.
    await checkHeartbeat(d, mailer, state, new Date('2026-09-25T00:11:00.000Z'));
    await checkHeartbeat(d, mailer, state, new Date('2026-09-25T00:12:00.000Z'));
    await checkHeartbeat(d, mailer, state, new Date('2026-09-25T00:30:00.000Z'));
    expect(sent).toHaveLength(1);

    // Recovers.
    lastHeartbeatAt = new Date('2026-09-25T00:31:00.000Z');
    await checkHeartbeat(d, mailer, state, new Date('2026-09-25T00:31:30.000Z'));
    expect(sent).toHaveLength(1);

    // Stale again after recovery: a second email.
    await checkHeartbeat(d, mailer, state, new Date('2026-09-25T00:40:00.000Z'));
    expect(sent).toHaveLength(2);
  });

  it('does not re-send within the hour for an episode that already alerted, even with a fresh in-memory state (a restart)', async () => {
    const lastHeartbeatAt = new Date('2026-09-25T00:00:00.000Z');
    const { db } = fakeDb({ id: AGENT_ID, fingerprint: FINGERPRINT, confirmedAt: new Date('2026-09-24T00:00:00.000Z'), lastHeartbeatAt });
    const { mailer, sent } = fakeMailer();
    const d = deps(db);

    // First process alerts once.
    const state1 = { alerted: false };
    await checkHeartbeat(d, mailer, state1, new Date('2026-09-25T00:10:00.000Z'));
    expect(sent).toHaveLength(1);

    // A "restart": fresh in-memory state, but the audit row from the first alert is still there
    // and within the hour, so no duplicate goes out.
    const state2 = { alerted: false };
    await checkHeartbeat(d, mailer, state2, new Date('2026-09-25T00:20:00.000Z'));
    expect(sent).toHaveLength(1);
  });
});
