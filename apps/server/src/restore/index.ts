import { Router, type Request } from 'express';
import {
  RESTORE_LIMIT_HOURS,
  RestoreRequest,
  lossWindowText,
  refusal,
  type DeployAccepted,
  type Refusal,
  type RestoreCandidate,
  type RestoreCandidates,
} from '@shipyard/schema';
import { assertCanActOn } from '../auth/scope.js';
import type { Db, Prisma } from '../db.js';
import type { ServiceDeps } from '../deps.js';
import { sendRefusal } from '../errors.js';
import { isUniqueViolation, lockRefusal } from '../deploys/service.js';

/**
 * Mounted at /api/apps · guided restore (SHP-T-5.6, SHP-REQ-083..085, SHP-D-038).
 *
 * - `GET /:app/restore` lists the backups deploys took (as the agent reported them), newest first,
 *   each with its loss window, and whether the 24-hour limit holds (SHP-REQ-084).
 * - `POST /:app/restore { backupDeployId, confirm }` asks the agent to restore one. `confirm` must
 *   be the app's name, typed exactly (SHP-REQ-083). Console only: a signed-in deployer, operator or
 *   admin — never a token, so no MCP session can start one (SHP-D-038). A frozen app may still be
 *   restored (SHP-REQ-077).
 *
 * The request names a deploy, never a path: the agent finds the artifact that deploy took in its
 * own ledger and refuses anything else (SHP-REQ-085). The server's checks here only spare a round
 * trip; the agent re-checks all of them.
 *
 * The restore is a `Deploy` of kind `restore` with one target in `locked` (holding the app's lock
 * like any deploy) and `rollbackToDeployId` = the deploy whose backup is restored, which the poll
 * sends as `toDeployId`. Its `requestedSha` is the SHA of the release the agent will run with the
 * restored data: the newest successful release of the app that ended before the backup was taken
 * — the code that matched the data at the time. The agent decides from its own ledger either way.
 */

const LIMIT_MS = RESTORE_LIMIT_HOURS * 60 * 60 * 1000;
const MAX_CANDIDATES = 20;

const CONSOLE_ONLY = refusal(
  'forbidden',
  'Restore is console-only: it discards writes, so a person confirms it by typing the app name.',
  'Open the app in the Shipyard console and choose Restore.',
);

function notFound(name: string): Refusal {
  return refusal('not_found', `No app named ${name}.`, 'List the apps and use one of their names.');
}

/** Reading: any signed-in user, viewers included. Tokens are refused; restore is console-only. */
function assertCanReadRestore(req: Request): Refusal | null {
  const type = req.actor?.type;
  if (type === undefined) return refusal('unauthenticated', 'You are not signed in.');
  if (type === 'token') return CONSOLE_ONLY;
  if (type !== 'user') return refusal('forbidden', `A ${type} actor cannot read restores.`);
  return null;
}

/** When the app's last completed restore ended, if within the limit. */
async function lastRestoreWithinLimit(db: Db, appId: string, now: Date): Promise<Date | null> {
  const last = await db.deployTarget.findFirst({
    where: { appId, state: 'succeeded', endedAt: { not: null }, deploy: { kind: 'restore', dryRun: false } },
    orderBy: { endedAt: 'desc' },
    select: { endedAt: true },
  });
  const endedAt = last?.endedAt ?? null;
  if (endedAt === null || now.getTime() - endedAt.getTime() >= LIMIT_MS) return null;
  return endedAt;
}

function limitRefusal(name: string, lastAt: Date): Refusal {
  const frees = new Date(lastAt.getTime() + LIMIT_MS);
  return refusal(
    'restore_limited',
    `${name} was restored at ${lastAt.toISOString()}; another restore is allowed from ${frees.toISOString()}.`,
    'A restore discards every write since its backup; one per app per 24 hours. Fix forward in the meantime.',
  );
}

/** The SHA of the newest release of the app that ended successfully before `before`, or null. */
async function releaseBefore(db: Db, appId: string, before: Date): Promise<string | null> {
  const release = await db.deployTarget.findFirst({
    where: { appId, state: 'succeeded', dispatchedAt: { not: null }, endedAt: { lte: before }, deploy: { dryRun: false } },
    orderBy: { endedAt: 'desc' },
    select: { deploy: { select: { requestedSha: true } } },
  });
  return release?.deploy.requestedSha ?? null;
}

interface ArtifactRow {
  path: string;
  size: bigint | null;
  createdAt: Date;
  targetId: string | null;
}

/** The backups the app's deploys took, with the deploy that took each, newest first. */
async function candidates(db: Db, appId: string, now: Date, available: boolean): Promise<RestoreCandidate[]> {
  const artifacts: ArtifactRow[] = await db.backupArtifact.findMany({
    where: { appId, targetId: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: MAX_CANDIDATES,
    select: { path: true, size: true, createdAt: true, targetId: true },
  });
  const targetIds = artifacts.flatMap((a) => (a.targetId === null ? [] : [a.targetId]));
  const targets = await db.deployTarget.findMany({
    where: { id: { in: targetIds }, deploy: { dryRun: false } },
    select: { id: true, deployId: true, deploy: { select: { kind: true, requestedSha: true } } },
  });
  const byId = new Map(targets.map((t) => [t.id, t]));
  const out: RestoreCandidate[] = [];
  for (const artifact of artifacts) {
    const target = artifact.targetId === null ? undefined : byId.get(artifact.targetId);
    if (target === undefined) continue;
    const lossWindowSeconds = Math.max(0, Math.floor((now.getTime() - artifact.createdAt.getTime()) / 1000));
    out.push({
      backupDeployId: target.deployId,
      backupDeployKind: target.deploy.kind,
      backupDeploySha: target.deploy.requestedSha,
      path: artifact.path,
      size: artifact.size === null ? null : Number(artifact.size),
      createdAt: artifact.createdAt.toISOString(),
      lossWindowSeconds,
      lossWindow: lossWindowText(lossWindowSeconds),
      releaseSha: await releaseBefore(db, appId, artifact.createdAt),
      available,
    });
  }
  return out;
}

export function restoreRouter(deps: ServiceDeps): Router {
  const router = Router();
  const { db, bus, logger } = deps;

  router.get('/:app/restore', async (req, res) => {
    const denied = assertCanReadRestore(req);
    if (denied !== null) {
      sendRefusal(res, denied);
      return;
    }
    const name = req.params['app'];
    const app = await db.app.findUnique({ where: { name }, select: { id: true, name: true } });
    if (app === null) {
      sendRefusal(res, notFound(name));
      return;
    }
    const now = new Date();
    const lastAt = await lastRestoreWithinLimit(db, app.id, now);
    const body: RestoreCandidates = {
      app: app.name,
      limited: lastAt === null ? null : { lastRestoreAt: lastAt.toISOString(), freesAt: new Date(lastAt.getTime() + LIMIT_MS).toISOString() },
      candidates: await candidates(db, app.id, now, lastAt === null),
    };
    res.json(body);
  });

  router.post('/:app/restore', async (req, res) => {
    const name = req.params['app'];
    const actor = req.actor;
    if (actor?.type === 'token') {
      sendRefusal(res, CONSOLE_ONLY);
      return;
    }
    const denied = assertCanActOn(req, name);
    if (denied !== null || actor === undefined) {
      sendRefusal(res, denied ?? refusal('unauthenticated', 'You are not signed in.'));
      return;
    }
    const parsed = RestoreRequest.safeParse(req.body);
    if (!parsed.success) {
      sendRefusal(
        res,
        refusal(
          'invalid_request',
          'The restore request failed validation.',
          parsed.error.issues.map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; '),
        ),
      );
      return;
    }
    const { backupDeployId, confirm } = parsed.data;
    if (confirm !== name) {
      sendRefusal(
        res,
        refusal('invalid_request', `The confirmation does not match: type ${name} exactly to restore it.`, `Type the app's name, ${name}, exactly.`),
      );
      return;
    }

    const app = await db.app.findUnique({ where: { name }, select: { id: true } });
    if (app === null) {
      sendRefusal(res, notFound(name));
      return;
    }

    // The backup that deploy took, as the agent reported it (the agent re-checks its own ledger).
    const took = await db.deployTarget.findFirst({ where: { deployId: backupDeployId, appId: app.id, deploy: { dryRun: false } }, select: { id: true } });
    const artifact =
      took === null
        ? null
        : await db.backupArtifact.findFirst({ where: { appId: app.id, targetId: took.id }, orderBy: { createdAt: 'desc' }, select: { path: true, createdAt: true } });
    if (artifact === null) {
      sendRefusal(res, refusal('restore_limited', `Deploy ${backupDeployId} took no backup of ${name} that the agent reported.`, 'Choose one of the backups listed for this app.'));
      return;
    }

    const now = new Date();
    const lastAt = await lastRestoreWithinLimit(db, app.id, now);
    if (lastAt !== null) {
      sendRefusal(res, limitRefusal(name, lastAt));
      return;
    }

    const sha = await releaseBefore(db, app.id, artifact.createdAt);
    if (sha === null) {
      sendRefusal(
        res,
        refusal('restore_limited', `No release of ${name} had completed before this backup was taken, so there is no code to run with its data.`, 'Choose another backup.'),
      );
      return;
    }

    const label = `${actor.label} (console)`;
    const data: Prisma.DeployCreateInput = {
      kind: 'restore',
      requestedSha: sha,
      dryRun: false,
      requesterLabel: label,
      ...(actor.type === 'user' && actor.id !== undefined ? { requesterUser: { connect: { id: actor.id } } } : {}),
      targets: {
        create: {
          app: { connect: { id: app.id } },
          // Straight into `locked`: the one-active-target index is the app's lock (SHP-D-061).
          state: 'locked',
          rollbackToDeployId: backupDeployId,
        },
      },
    };

    let deployId: string | undefined;
    for (let attempt = 0; attempt < 2 && deployId === undefined; attempt += 1) {
      try {
        const row = await db.deploy.create({ data, select: { id: true } });
        deployId = row.id;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const locked = await lockRefusal(db, name, app.id);
        if (locked !== null) {
          sendRefusal(res, locked);
          return;
        }
      }
    }
    if (deployId === undefined) {
      sendRefusal(res, refusal('locked', `${name} is being deployed by someone else.`));
      return;
    }

    const lossWindowSeconds = Math.max(0, Math.floor((now.getTime() - artifact.createdAt.getTime()) / 1000));
    await req.audit({
      action: 'deploy.requested',
      entityType: 'deploy',
      entityId: deployId,
      after: {
        app: name,
        kind: 'restore',
        sha,
        dryRun: false,
        state: 'locked',
        backupDeployId,
        artifact: artifact.path,
        artifactCreatedAt: artifact.createdAt.toISOString(),
        lossWindowSeconds,
        requester: { label, repo: null, branch: null },
      },
    });
    logger.info({ deployId, app: name, backupDeployId, lossWindowSeconds }, 'restore requested');
    bus.publish('work');
    const accepted: DeployAccepted = { deployId, state: 'locked' };
    res.status(201).json(accepted);
  });

  return router;
}
