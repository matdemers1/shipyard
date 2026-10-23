import { StackManifest, type AgentStackService } from '../../packages/schema/src/index.js';
import type { Db } from './db.js';
import { HOST_FIXTURE } from './host.js';
import { DAY, HOUR, MINUTE, ago, digest } from './seed.js';

/**
 * An adopted stack updated by digest (SHP-T-16.6, SHP-ADR-010): the baseline host's Operated compose
 * project (`immich`) adopted with `updates: digest`, the services mirror an agent on SHP-P-16 would
 * have reported — a candidate one release ahead (SHP-REQ-194) — and a history of updates
 * (SHP-REQ-200): two successes and, newest, one rolled back after a failed health check, so Needs
 * you has a stack to warn about. `seedHeldStackUpdate` adds a token's request held for a deployer
 * (SHP-REQ-199).
 *
 * Written the way the agent's report and the server's stack-update service leave the rows. The
 * manifest is parsed with the schema first, so a fixture the server would not read fails here.
 * Put the baseline back with `reseedWorld` afterwards: the stack rows cascade from the agent.
 */

export const STACK_FIXTURE = {
  name: HOST_FIXTURE.operatedProject,
  service: 'server',
  image: 'ghcr.io/immich-app/immich-server',
  /** What runs now: the baseline container's own tag. */
  running: 'v1.140.0',
  candidate: 'v1.141.0',
  /** The earlier success Roll back is offered on. */
  rollBackTo: 'v1.139.0',
  soakSeconds: 120,
  heldRequester: 'claude: homelab upkeep',
  rolledBackMessage: 'Health check: the container reported unhealthy 3 times in 60 s.',
  rolledBackFix: "Read the container's logs, then update again or pin v1.140.0.",
} as const;

const at = (tag: string) => digest(`immich-server@${tag}`);

function manifest(): StackManifest {
  return StackManifest.parse({
    kind: 'stack',
    name: STACK_FIXTURE.name,
    compose: { files: [`/DATA/AppData/${STACK_FIXTURE.name}/docker-compose.yml`], project: STACK_FIXTURE.name },
    updates: 'digest',
    services: { [STACK_FIXTURE.service]: { image: STACK_FIXTURE.image, track: { semver: '^1.140' } } },
    steps: { backup: { service: STACK_FIXTURE.service, argv: ['immich-admin', 'backup'], artifactsDir: `/DATA/backups/${STACK_FIXTURE.name}` } },
    soakSeconds: STACK_FIXTURE.soakSeconds,
    approval: 'tokens',
  });
}

function image(tag: string): { service: string; tag: string; digest: string } {
  return { service: STACK_FIXTURE.service, tag, digest: at(tag) };
}

/** Adopts `immich` for digest updates with a candidate and three updates of history; returns its row ID. */
export async function seedDigestStack(db: Db, agentId: string, adminLabel: string, now: number = Date.now()): Promise<string> {
  const services: Record<string, AgentStackService> = {
    [STACK_FIXTURE.service]: {
      running: at(STACK_FIXTURE.running),
      candidate: { tag: STACK_FIXTURE.candidate, digest: at(STACK_FIXTURE.candidate) },
      checkedAt: ago(5 * MINUTE, now).toISOString(),
      error: null,
    },
  };
  const stack = await db.stack.create({
    data: {
      name: STACK_FIXTURE.name,
      agentId,
      manifestJson: JSON.stringify(manifest()),
      manifestSha256: 'c'.repeat(64),
      composeProject: STACK_FIXTURE.name,
      services,
      reportedAt: new Date(now),
    },
    select: { id: true },
  });
  const base = { stackId: stack.id, stackName: STACK_FIXTURE.name, agentId, soakSeconds: STACK_FIXTURE.soakSeconds };
  const ended = (created: Date) => ({ createdAt: created, startedAt: created, dispatchedAt: created, endedAt: new Date(created.getTime() + 3 * MINUTE) });
  await db.stackUpdate.create({
    data: {
      ...base,
      state: 'succeeded',
      digests: { [STACK_FIXTURE.service]: at('v1.139.0') },
      images: [image('v1.139.0')],
      previous: [image('v1.138.0')],
      requesterLabel: 'claude: immich',
      decidedByLabel: adminLabel,
      decidedAt: ago(22 * DAY, now),
      heldAt: ago(22 * DAY + HOUR, now),
      ...ended(ago(22 * DAY + HOUR, now)),
    },
  });
  await db.stackUpdate.create({
    data: {
      ...base,
      state: 'succeeded',
      digests: { [STACK_FIXTURE.service]: at(STACK_FIXTURE.running) },
      images: [image(STACK_FIXTURE.running)],
      previous: [image('v1.139.0')],
      requesterLabel: `${adminLabel} (console)`,
      ...ended(ago(10 * DAY, now)),
    },
  });
  await db.stackUpdate.create({
    data: {
      ...base,
      state: 'rolled_back',
      digests: { [STACK_FIXTURE.service]: at('v1.140.1') },
      images: [image(STACK_FIXTURE.running)],
      previous: [image(STACK_FIXTURE.running)],
      requesterLabel: `${adminLabel} (console)`,
      refusal: { code: 'health_failed', gate: 'none', message: STACK_FIXTURE.rolledBackMessage, fix: STACK_FIXTURE.rolledBackFix },
      ...ended(ago(2 * HOUR, now)),
    },
  });
  return stack.id;
}

/** A token's request for the candidate, held for a deployer's approval (SHP-REQ-199). */
export async function seedHeldStackUpdate(db: Db, stackId: string, agentId: string, now: number = Date.now()): Promise<string> {
  const row = await db.stackUpdate.create({
    data: {
      stackId,
      stackName: STACK_FIXTURE.name,
      agentId,
      soakSeconds: STACK_FIXTURE.soakSeconds,
      state: 'awaiting_approval',
      digests: { [STACK_FIXTURE.service]: at(STACK_FIXTURE.candidate) },
      requesterLabel: STACK_FIXTURE.heldRequester,
      heldAt: ago(3 * MINUTE, now),
      createdAt: ago(3 * MINUTE, now),
    },
    select: { id: true },
  });
  return row.id;
}
