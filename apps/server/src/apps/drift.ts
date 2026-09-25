import { ACTIVE_STATES, refusal, type Refusal } from '@shipyard/schema';
import type { Db, Prisma } from '../db.js';

/**
 * Drift (SHP-REQ-054, SHP-D-031): the agent observes running digests that differ from the release
 * Shipyard last recorded for an app. The server flags the app and refuses forward deploys until a
 * human resolves it (adopt-live or redeploy-recorded, Phase 3). Nothing here ever reverts anything.
 */

export type DbClient = Db | Prisma.TransactionClient;

/** service → digest. */
export type DigestMap = Record<string, string>;

export interface RecordedRelease {
  targetId: string;
  deployId: string;
  /** The SHA the release was built from (every image of one target shares it). */
  sha: string | null;
  digests: DigestMap;
  endedAt: Date | null;
}

/** The app's recorded release: its most recent `succeeded` target's images, or null if none yet. */
export async function recordedRelease(db: DbClient, appId: string): Promise<RecordedRelease | null> {
  const target = await db.deployTarget.findFirst({
    where: { appId, state: 'succeeded', deploy: { dryRun: false } },
    orderBy: [{ endedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    select: { id: true, deployId: true, endedAt: true, images: { select: { service: true, sha: true, digest: true } } },
  });
  if (target === null) return null;
  const digests: DigestMap = {};
  for (const image of target.images) digests[image.service] = image.digest;
  return {
    targetId: target.id,
    deployId: target.deployId,
    sha: target.images[0]?.sha ?? null,
    digests,
    endedAt: target.endedAt,
  };
}

/**
 * The services whose observed digest differs from the recorded one. A service the agent sees no
 * container for (null) is not a digest observation and is not counted: a stopped container is not
 * a different release. A service the record does not name is not compared.
 */
export function differingServices(recorded: DigestMap, observed: Record<string, string | null>): string[] {
  const out: string[] = [];
  for (const [service, digest] of Object.entries(recorded)) {
    const seen = observed[service];
    if (seen === undefined || seen === null) continue;
    if (seen !== digest) out.push(service);
  }
  return out.sort();
}

export interface DriftOutcome {
  /** True when this report opened a new drift event. */
  opened: boolean;
  services: string[];
}

/**
 * Compares one app's observed digests with its recorded release, inside the report's transaction.
 * Opens a DriftEvent and sets `app.driftedAt` when they differ and none is open. Equal digests
 * leave an open event alone: resolving drift is an explicit human act. An app with a target in
 * flight is skipped — its digests are mid-swap, not drifted.
 */
export async function detectDrift(
  tx: Prisma.TransactionClient,
  app: { id: string },
  observed: Record<string, string | null>,
): Promise<DriftOutcome> {
  const active = await tx.deployTarget.count({ where: { appId: app.id, state: { in: [...ACTIVE_STATES] } } });
  if (active > 0) return { opened: false, services: [] };

  const recorded = await recordedRelease(tx, app.id);
  if (recorded === null) return { opened: false, services: [] };

  const services = differingServices(recorded.digests, observed);
  if (services.length === 0) return { opened: false, services };

  const open = await tx.driftEvent.findFirst({ where: { appId: app.id, resolvedAt: null }, select: { id: true } });
  if (open !== null) return { opened: false, services };

  const now = new Date();
  await tx.driftEvent.create({
    data: { appId: app.id, observed, recorded: recorded.digests, detectedAt: now },
  });
  await tx.app.update({ where: { id: app.id }, data: { driftedAt: now } });
  return { opened: true, services };
}

/**
 * The deploy API's pre-check for one app (SHP-REQ-037, SHP-REQ-054): `unknown_app` if the agent has
 * never reported it, `drift_unresolved` (G3) while it has an open drift event, else null.
 */
export async function assertDeployable(db: DbClient, appName: string): Promise<Refusal | null> {
  const app = await db.app.findUnique({ where: { name: appName }, select: { id: true, reportedAt: true, driftedAt: true } });
  if (app === null || app.reportedAt === null) {
    return refusal('unknown_app', `The agent has not reported an app named ${appName}.`);
  }
  if (app.driftedAt !== null) {
    const open = await db.driftEvent.findFirst({
      where: { appId: app.id, resolvedAt: null },
      orderBy: { detectedAt: 'desc' },
      select: { detectedAt: true },
    });
    if (open !== null) {
      return refusal(
        'drift_unresolved',
        `${appName} is running images that differ from its recorded release (drift detected ${open.detectedAt.toISOString()}).`,
        'Resolve the drift first: adopt what is live, or redeploy the recorded release.',
      );
    }
  }
  return null;
}
