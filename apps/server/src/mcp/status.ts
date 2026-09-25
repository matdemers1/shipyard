import { ACTIVE_STATES } from '@shipyard/schema';
import { recordedRelease } from '../apps/index.js';
import type { Db } from '../db.js';
import { TERMINAL_STATES } from '../deploys/service.js';

/**
 * The read-only view behind `shipyard_status` (SHP-T-2.8). Built from the same rows the console's
 * app mirror reads; nothing here writes.
 */

export interface McpAppStatus {
  name: string;
  repo: string | null;
  defaultBranch: string | null;
  reportedAt: string | null;
  /** The recorded release: the last succeeded target. Null when Shipyard has never deployed it. */
  live: {
    sha: string | null;
    digests: Record<string, string>;
    schemaRevision: string | null;
    deployId: string;
    endedAt: string | null;
  } | null;
  /** Open drift: running digests differ from the recorded release. Blocks forward deploys. */
  drift: { detectedAt: string; observed: unknown; recorded: unknown } | null;
  /** Who holds the app's deploy lock, and at which step; null when nobody does. */
  lock: { deployId: string; holder: string; state: string; step: string | null } | null;
  /** The newest finished target (deploy, rollback or dry run). */
  lastResult: {
    deployId: string;
    kind: string;
    sha: string;
    dryRun: boolean;
    state: string;
    requester: string;
    endedAt: string | null;
    refusal: unknown;
  } | null;
}

export async function appStatuses(db: Db, names: readonly string[]): Promise<McpAppStatus[]> {
  const apps = await db.app.findMany({
    where: { name: { in: [...names] } },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, repo: true, defaultBranch: true, reportedAt: true },
  });
  return Promise.all(
    apps.map(async (app): Promise<McpAppStatus> => {
      const [release, drift, active, last] = await Promise.all([
        recordedRelease(db, app.id),
        db.driftEvent.findFirst({
          where: { appId: app.id, resolvedAt: null },
          orderBy: { detectedAt: 'desc' },
          select: { detectedAt: true, observed: true, recorded: true },
        }),
        db.deployTarget.findFirst({
          where: { appId: app.id, state: { in: [...ACTIVE_STATES] } },
          select: { deployId: true, state: true, currentStep: true, deploy: { select: { requesterLabel: true } } },
        }),
        db.deployTarget.findFirst({
          where: { appId: app.id, state: { in: [...TERMINAL_STATES] } },
          orderBy: [{ endedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
          select: {
            deployId: true,
            state: true,
            endedAt: true,
            refusal: true,
            deploy: { select: { kind: true, requestedSha: true, dryRun: true, requesterLabel: true } },
          },
        }),
      ]);
      const releaseTarget =
        release === null
          ? null
          : await db.deployTarget.findUnique({ where: { id: release.targetId }, select: { schemaRevision: true } });
      return {
        name: app.name,
        repo: app.repo,
        defaultBranch: app.defaultBranch,
        reportedAt: app.reportedAt?.toISOString() ?? null,
        live:
          release === null
            ? null
            : {
                sha: release.sha,
                digests: release.digests,
                schemaRevision: releaseTarget?.schemaRevision ?? null,
                deployId: release.deployId,
                endedAt: release.endedAt?.toISOString() ?? null,
              },
        drift:
          drift === null
            ? null
            : { detectedAt: drift.detectedAt.toISOString(), observed: drift.observed, recorded: drift.recorded },
        lock:
          active === null
            ? null
            : {
                deployId: active.deployId,
                holder: active.deploy.requesterLabel,
                state: active.state,
                step: active.currentStep,
              },
        lastResult:
          last === null
            ? null
            : {
                deployId: last.deployId,
                kind: last.deploy.kind,
                sha: last.deploy.requestedSha,
                dryRun: last.deploy.dryRun,
                state: last.state,
                requester: last.deploy.requesterLabel,
                endedAt: last.endedAt?.toISOString() ?? null,
                refusal: last.refusal,
              },
      };
    }),
  );
}
