import { Router, type Request, type Response } from 'express';
import { ACTIVE_STATES, refusal } from '@shipyard/schema';
import type { Db, Prisma } from '../db.js';
import type { ServiceDeps } from '../deps.js';
import { sendRefusal } from '../errors.js';
import { recordedRelease } from './drift.js';

export { assertDeployable, detectDrift, differingServices, recordedRelease } from './drift.js';

/**
 * GET /api/apps and /api/apps/:app — the read-only mirror of what the agent reported (SHP-D-060).
 * Nothing here writes: app rows change only through the agent's report (SHP-REQ-104).
 */

const APP_SELECT = {
  id: true,
  name: true,
  repo: true,
  defaultBranch: true,
  services: true,
  soakSeconds: true,
  approvalPolicy: true,
  canary: true,
  groupName: true,
  reportedAt: true,
  runningDigests: true,
  driftedAt: true,
  manifestSha256: true,
} satisfies Prisma.AppSelect;

type AppRow = Prisma.AppGetPayload<{ select: typeof APP_SELECT }>;

interface AppSummary {
  name: string;
  repo: string | null;
  defaultBranch: string | null;
  services: unknown;
  /** The recorded release (the last succeeded target); null when Shipyard has never deployed it. */
  liveSha: string | null;
  digests: Record<string, string> | null;
  running: unknown;
  drift: { id: string; detectedAt: string; observed: unknown; recorded: unknown } | null;
  reportedAt: string | null;
  soakSeconds: number | null;
  approvalPolicy: string | null;
  canary: boolean;
  group: string | null;
  manifestSha256: string;
  active: { targetId: string; deployId: string; state: string; holder: string; currentStep: string | null } | null;
}

async function summarise(db: Db, app: AppRow): Promise<AppSummary> {
  const [release, drift, active] = await Promise.all([
    recordedRelease(db, app.id),
    db.driftEvent.findFirst({
      where: { appId: app.id, resolvedAt: null },
      orderBy: { detectedAt: 'desc' },
      select: { id: true, detectedAt: true, observed: true, recorded: true },
    }),
    db.deployTarget.findFirst({
      where: { appId: app.id, state: { in: [...ACTIVE_STATES] } },
      select: { id: true, deployId: true, state: true, currentStep: true, deploy: { select: { requesterLabel: true } } },
    }),
  ]);
  return {
    name: app.name,
    repo: app.repo,
    defaultBranch: app.defaultBranch,
    services: app.services,
    liveSha: release?.sha ?? null,
    digests: release?.digests ?? null,
    running: app.runningDigests,
    drift:
      drift === null
        ? null
        : { id: drift.id, detectedAt: drift.detectedAt.toISOString(), observed: drift.observed, recorded: drift.recorded },
    reportedAt: app.reportedAt?.toISOString() ?? null,
    soakSeconds: app.soakSeconds,
    approvalPolicy: app.approvalPolicy,
    canary: app.canary,
    group: app.groupName,
    manifestSha256: app.manifestSha256,
    active:
      active === null
        ? null
        : {
            targetId: active.id,
            deployId: active.deployId,
            state: active.state,
            holder: active.deploy.requesterLabel,
            currentStep: active.currentStep,
          },
  };
}

/** A signed-in user or an API token may read; anyone else (anonymous, agent) is refused. */
function readerOrRefuse(req: Request, res: Response): boolean {
  const type = req.actor?.type;
  if (type !== 'user' && type !== 'token') {
    sendRefusal(res, refusal('unauthenticated', 'You are not signed in.'));
    return false;
  }
  return true;
}

/** For a token, the apps it is scoped to; for a user, undefined (every app). */
function scopeOf(req: Request): ReadonlySet<string> | undefined {
  return req.actor?.type === 'token' ? (req.tokenApps ?? new Set<string>()) : undefined;
}

export function appsRouter(deps: ServiceDeps): Router {
  const { db } = deps;
  const router = Router();

  router.get('/', async (req, res) => {
    if (!readerOrRefuse(req, res)) return;
    const scope = scopeOf(req);
    const rows = await db.app.findMany({
      where: scope === undefined ? {} : { name: { in: [...scope] } },
      orderBy: { name: 'asc' },
      select: APP_SELECT,
    });
    const apps = await Promise.all(rows.map((row) => summarise(db, row)));
    res.json({ apps });
  });

  router.get('/:app', async (req, res) => {
    if (!readerOrRefuse(req, res)) return;
    const name = req.params['app'];
    const scope = scopeOf(req);
    const notFound = refusal('not_found', `No app named ${name}.`, 'List the apps and use one of their names.');
    // A token outside its scope sees the same answer as for an app that does not exist.
    if (typeof name !== 'string' || (scope !== undefined && !scope.has(name))) {
      sendRefusal(res, notFound);
      return;
    }
    const row = await db.app.findUnique({ where: { name }, select: { ...APP_SELECT, manifestYaml: true } });
    if (row === null) {
      sendRefusal(res, notFound);
      return;
    }
    const [summary, targets] = await Promise.all([
      summarise(db, row),
      db.deployTarget.findMany({
        where: { appId: row.id },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          deployId: true,
          state: true,
          currentStep: true,
          createdAt: true,
          startedAt: true,
          endedAt: true,
          deploy: { select: { kind: true, requestedSha: true, requesterLabel: true, dryRun: true } },
          images: { select: { service: true, repo: true, sha: true, digest: true } },
        },
      }),
    ]);
    let manifest: unknown;
    try {
      manifest = JSON.parse(row.manifestYaml) as unknown;
    } catch {
      // A row written before the mirror stored canonical JSON: hand back the text as it is.
      manifest = row.manifestYaml;
    }
    res.json({
      ...summary,
      manifest,
      targets: targets.map((t) => ({
        id: t.id,
        deployId: t.deployId,
        kind: t.deploy.kind,
        sha: t.deploy.requestedSha,
        dryRun: t.deploy.dryRun,
        requester: t.deploy.requesterLabel,
        state: t.state,
        currentStep: t.currentStep,
        createdAt: t.createdAt.toISOString(),
        startedAt: t.startedAt?.toISOString() ?? null,
        endedAt: t.endedAt?.toISOString() ?? null,
        images: t.images,
      })),
    });
  });

  return router;
}
