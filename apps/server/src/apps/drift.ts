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
  /**
   * True when the agent executed it (it was dispatched): a release in the agent's own ledger. An
   * adopt-live record is written by the server alone and is false (SHP-D-080).
   */
  agentExecuted: boolean;
}

/** The app's recorded release: its most recent `succeeded` target's images, or null if none yet. */
export async function recordedRelease(db: DbClient, appId: string): Promise<RecordedRelease | null> {
  const target = await db.deployTarget.findFirst({
    where: { appId, state: 'succeeded', deploy: { dryRun: false } },
    orderBy: [{ endedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    select: {
      id: true,
      deployId: true,
      endedAt: true,
      dispatchedAt: true,
      images: { select: { service: true, sha: true, digest: true } },
    },
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
    agentExecuted: target.dispatchedAt !== null,
  };
}

/**
 * The services whose observed digest differs from the recorded one. A service the agent sees no
 * container for (null) is not a digest observation and is not counted: a stopped container is not
 * a different release. A service the manifest maps (`mapped`) that the record does not name, but
 * that is running, differs: the record says nothing about it, so whatever runs was never recorded
 * (a service stopped when a release was recorded must not start later, unseen, as anything at all).
 */
export function differingServices(
  recorded: DigestMap,
  observed: Record<string, string | null>,
  mapped: readonly string[] = [],
): string[] {
  const out = new Set<string>();
  for (const [service, digest] of Object.entries(recorded)) {
    const seen = observed[service];
    if (seen === undefined || seen === null) continue;
    if (seen !== digest) out.add(service);
  }
  for (const service of mapped) {
    if (service in recorded) continue;
    const seen = observed[service];
    if (seen !== undefined && seen !== null) out.add(service);
  }
  return [...out].sort();
}

/** Every recorded service is running exactly its recorded digest, and nothing else differs. */
export function matchesRecorded(recorded: DigestMap, observed: Record<string, string | null>, mapped: readonly string[] = []): boolean {
  const services = Object.entries(recorded);
  if (services.length === 0) return false;
  return services.every(([service, digest]) => observed[service] === digest) && differingServices(recorded, observed, mapped).length === 0;
}

/** A superseded event's reason starts with this, followed by the newer event's id. */
export const SUPERSEDED_PREFIX = 'Superseded: the agent then observed different digests, drift event ';

/** Two observations name the same digest (or the same absence) for every service either names. */
function sameObservation(before: Prisma.JsonValue, now: Record<string, string | null>): boolean {
  const prior = typeof before === 'object' && before !== null && !Array.isArray(before) ? before : {};
  const names = new Set([...Object.keys(prior), ...Object.keys(now)]);
  for (const name of names) {
    const a = prior[name];
    const b = now[name];
    if ((typeof a === 'string' ? a : null) !== (b ?? null)) return false;
  }
  return true;
}

export interface DriftOutcome {
  /** True when this report opened a new drift event (superseding an open one included). */
  opened: boolean;
  /** True when this report resolved a pending redeploy-recorded (the recorded release runs again). */
  resolved: boolean;
  /**
   * True when an open drift event was closed because the release this report imported from the
   * agent ledger (SHP-REQ-111) is now the recorded one and is exactly what runs.
   */
  closedByImport?: boolean;
  services: string[];
}

/**
 * Compares one app's observed digests with its recorded release, inside the report's transaction.
 * Opens a DriftEvent and sets `app.driftedAt` when they differ and none is open, or when the open
 * one no longer shows what runs (it is superseded). Equal digests
 * leave an open event alone: resolving drift is an explicit human act — with one exception that
 * is still that human's act: a redeploy-recorded that a deployer requested (the event is pending,
 * `resolution = redeploy_recorded` with no `resolvedAt`) is resolved here, and only here, when the
 * running digests equal the recorded release again (SHP-REQ-066). An app with a target in flight
 * is skipped — its digests are mid-swap, not drifted.
 */
/** The pending redeploy's rollback deploy id, as the redeploy route writes it into the event's reason. */
const PENDING_DEPLOY_RE = /as deploy ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export async function detectDrift(
  tx: Prisma.TransactionClient,
  app: { id: string },
  observed: Record<string, string | null>,
  mapped: readonly string[] = [],
  /** Deploy IDs this report imported from the agent ledger. */
  imported: ReadonlySet<string> = new Set(),
): Promise<DriftOutcome> {
  const active = await tx.deployTarget.count({ where: { appId: app.id, state: { in: [...ACTIVE_STATES] } } });
  if (active > 0) return { opened: false, resolved: false, services: [] };

  const recorded = await recordedRelease(tx, app.id);
  if (recorded === null) return { opened: false, resolved: false, services: [] };

  const services = differingServices(recorded.digests, observed, mapped);
  const open = await tx.driftEvent.findFirst({
    where: { appId: app.id, resolvedAt: null },
    orderBy: { detectedAt: 'desc' },
    select: { id: true, resolution: true, reason: true, observed: true },
  });

  if (services.length === 0) {
    if (open !== null && imported.has(recorded.deployId) && matchesRecorded(recorded.digests, observed, mapped)) {
      // What drifted was a verified release deployed outside the server (the host CLI): the agent's
      // ledger vouches for it, it is now recorded, and it is exactly what runs. Nothing is left to
      // resolve; close the event without claiming a human resolution.
      await tx.driftEvent.update({
        where: { id: open.id },
        data: {
          resolvedAt: new Date(),
          resolution: null,
          reason: `${open.reason === null ? '' : `${open.reason} — `}closed: release ${recorded.deployId} from the agent ledger, deployed outside the server, is what runs`.slice(0, 1000),
        },
      });
      await tx.app.update({ where: { id: app.id }, data: { driftedAt: null } });
      return { opened: false, resolved: false, closedByImport: true, services };
    }
    if (open?.resolution === 'redeploy_recorded' && matchesRecorded(recorded.digests, observed, mapped)) {
      // Resolved as a redeploy only when the release now recorded is that redeploy's own rollback.
      // If something else shipped over the drift, what runs matches a record again, but the
      // redeploy did not do it: close the event without claiming a resolution it did not have.
      const pendingDeployId = PENDING_DEPLOY_RE.exec(open.reason ?? '')?.[1] ?? null;
      const byTheRedeploy = pendingDeployId !== null && recorded.deployId === pendingDeployId;
      await tx.driftEvent.update({
        where: { id: open.id },
        data: byTheRedeploy
          ? { resolvedAt: new Date() }
          : { resolvedAt: new Date(), resolution: null, reason: `${open.reason ?? ''} — closed: deploy ${recorded.deployId} shipped over the drift, not the redeploy` },
      });
      await tx.app.update({ where: { id: app.id }, data: { driftedAt: null } });
      return { opened: false, resolved: byTheRedeploy, services };
    }
    return { opened: false, resolved: false, services };
  }
  if (open !== null && sameObservation(open.observed, observed)) return { opened: false, resolved: false, services };

  const now = new Date();
  const created = await tx.driftEvent.create({
    data: { appId: app.id, observed, recorded: recorded.digests, detectedAt: now },
    select: { id: true },
  });
  if (open !== null) {
    // What runs changed again while the drift was open: the old event no longer shows what is
    // running, so it is closed as superseded (no resolution) and the deployer reviews the new one.
    // An adopt that names the old event is refused as stale rather than adopting digests nobody saw.
    const prior = open.resolution === 'redeploy_recorded' && open.reason !== null ? ` ${open.reason}` : '';
    await tx.driftEvent.update({
      where: { id: open.id },
      data: { resolvedAt: now, resolution: null, reason: `${SUPERSEDED_PREFIX}${created.id}.${prior}`.slice(0, 1000) },
    });
    await tx.app.update({ where: { id: app.id }, data: { driftedAt: now } });
    return { opened: true, resolved: false, services };
  }
  await tx.app.update({ where: { id: app.id }, data: { driftedAt: now } });
  return { opened: true, resolved: false, services };
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
      select: { detectedAt: true, resolution: true },
    });
    if (open !== null) {
      return refusal(
        'drift_unresolved',
        `${appName} is running images that differ from its recorded release (drift detected ${open.detectedAt.toISOString()}).`,
        open.resolution === 'redeploy_recorded'
          ? 'A redeploy of the recorded release was requested; deploys are allowed once the agent reports it running again. Or adopt what is live.'
          : 'Resolve the drift first: adopt what is live, or redeploy the recorded release.',
      );
    }
  }
  return null;
}

/**
 * Clears `app.driftedAt` once a deployer has adopted what is running (SHP-REQ-066), in `detail.ts`;
 * a redeploy-recorded is cleared by `detectDrift` when the recorded release runs again. The only app-row write outside the report, kept here so the
 * report and drift remain the only writers (SHP-REQ-104).
 */
export async function clearDrifted(db: DbClient, appId: string): Promise<void> {
  await db.app.update({ where: { id: appId }, data: { driftedAt: null } });
}
