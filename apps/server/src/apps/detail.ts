import type { Request, Response, Router } from 'express';
import { refusal, type Refusal } from '@shipyard/schema';
import type { Db, Prisma } from '../db.js';
import type { ServiceDeps } from '../deps.js';
import { sendRefusal } from '../errors.js';
import { assertCanActOn } from '../auth/scope.js';
import { callerFromRequest, createDeploy, isRefusal, lockRefusal, type DeployableCheck } from '../deploys/service.js';
import { assertDeployable, clearDrifted, recordedRelease, type DigestMap } from './drift.js';
import { activeFreezeInfo } from '../freeze/service.js';
export type { FreezeInfo } from '@shipyard/schema';

/**
 * App detail (SHP-T-3.5): the rollback targets the agent's ledger would accept (SHP-REQ-063,
 * SHP-D-080), and drift resolution (SHP-REQ-066, SHP-D-031, SHP-D-085). Drift is never reverted
 * on its own: a deployer either adopts what is running, with a written reason, or redeploys the
 * recorded release.
 */

/** How many releases the agent's ledger offers as rollback candidates, the live one included. */
export const LEDGER_WINDOW = 5;

/** An adopt-live record's label starts with this; it is not a release the agent deployed. */
export const ADOPT_LABEL_PREFIX = 'adopt-live by ';

/** The SHA recorded when the running image's source commit is not known. */
export const UNKNOWN_SHA = '0'.repeat(40);

export const REASON_MAX = 200;

export interface ReleaseImage {
  service: string;
  sha: string;
  digest: string;
  migration: string | null;
}

export interface Release {
  deployId: string;
  targetId: string;
  kind: string;
  sha: string;
  requester: string;
  endedAt: string | null;
  images: ReleaseImage[];
}

export interface NeedsRestore extends Release {
  reason: string;
}

export interface RollbackTargets {
  rollbackTargets: Release[];
  needsRestore: NeedsRestore[];
}

const RELEASE_SELECT = {
  id: true,
  deployId: true,
  endedAt: true,
  deploy: { select: { kind: true, requestedSha: true, requesterLabel: true } },
  images: { select: { service: true, sha: true, digest: true, migrationLabel: true }, orderBy: { service: 'asc' } },
} satisfies Prisma.DeployTargetSelect;

type ReleaseRow = Prisma.DeployTargetGetPayload<{ select: typeof RELEASE_SELECT }>;

function toRelease(row: ReleaseRow): Release {
  return {
    deployId: row.deployId,
    targetId: row.id,
    kind: row.deploy.kind,
    sha: row.deploy.requestedSha,
    requester: row.deploy.requesterLabel,
    endedAt: row.endedAt?.toISOString() ?? null,
    images: row.images.map((i) => ({ service: i.service, sha: i.sha, digest: i.digest, migration: i.migrationLabel })),
  };
}

function isContract(label: string | null): boolean {
  return label?.trim().toLowerCase() === 'contract';
}

/**
 * The server's mirror of the agent's ledger window: the last five succeeded, non-dry-run deploys
 * and rollbacks of the app (an adopt-live record is not one — the agent never deployed it), newest
 * first. The newest is live and is never a target, nor is the recorded release; that leaves at most
 * four. A candidate with a contract-labelled release after it would be refused at G10
 * (`later_contract_release`), so it is listed apart as needing a restore.
 */
export async function rollbackTargets(db: Db, appId: string): Promise<RollbackTargets> {
  const [window, recorded] = await Promise.all([
    db.deployTarget.findMany({
      where: {
        appId,
        state: 'succeeded',
        deploy: { dryRun: false, kind: { in: ['deploy', 'rollback'] } },
        NOT: { dispatchedAt: null, deploy: { requesterLabel: { startsWith: ADOPT_LABEL_PREFIX } } },
      },
      orderBy: [{ endedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      take: LEDGER_WINDOW,
      select: RELEASE_SELECT,
    }),
    recordedRelease(db, appId),
  ]);

  const out: RollbackTargets = { rollbackTargets: [], needsRestore: [] };
  // Every release newer than the candidate being looked at; the live one comes first.
  const newer: ReleaseRow[] = [];
  for (const [index, row] of window.entries()) {
    const isLive = index === 0 || row.deployId === recorded?.deployId;
    if (!isLive) {
      const contract = newer.find((later) => later.images.some((image) => isContract(image.migrationLabel)));
      if (contract === undefined) {
        out.rollbackTargets.push(toRelease(row));
      } else {
        out.needsRestore.push({
          ...toRelease(row),
          reason: `Release ${contract.deploy.requestedSha.slice(0, 7)} (deploy ${contract.deployId}) after it carried a contract migration; rolling back would break the schema, so it needs a restore.`,
        });
      }
    }
    newer.push(row);
  }
  return out;
}

/**
 * The active freeze on the app, `{reason, by, from, until}`, for the app detail response
 * (SHP-T-5.1, SHP-REQ-077) — null when it is not frozen. `apps/index.ts`'s `GET /:app` spreads
 * `{ freeze: await activeFreeze(db, row.id) }` into its response.
 */
export const activeFreeze = activeFreezeInfo;

/** The recorded release's schema revision, when the agent reported one. */
export async function liveSchemaRevision(db: Db, targetId: string | undefined): Promise<string | null> {
  if (targetId === undefined) return null;
  const row = await db.deployTarget.findUnique({ where: { id: targetId }, select: { schemaRevision: true } });
  return row?.schemaRevision ?? null;
}

// ── Drift resolution ────────────────────────────────────────────────────

/** 1–200 printable characters on one line, surrounding space ignored; else the refusal naming `reason`. */
export function parseReason(body: unknown): string | Refusal {
  const raw = typeof body === 'object' && body !== null ? (body as { reason?: unknown }).reason : undefined;
  const fix = `Send { "reason": "…" }: one line of 1–${String(REASON_MAX)} printable characters saying why what is running is right.`;
  if (typeof raw !== 'string') return refusal('invalid_request', 'reason is required to adopt what is running.', fix);
  const reason = raw.trim();
  if (reason.length === 0) return refusal('invalid_request', 'reason is required to adopt what is running.', fix);
  if (reason.length > REASON_MAX) {
    return refusal('invalid_request', `reason is ${String(reason.length)} characters; the limit is ${String(REASON_MAX)}.`, fix);
  }
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(reason)) {
    return refusal('invalid_request', 'reason must be printable characters on one line.', fix);
  }
  return reason;
}

/**
 * Drift is resolved from the console by a deployer: a signed-in user, never a token (an agent
 * session must not be able to wave its own drift through), and never a viewer.
 */
function resolverOrRefuse(req: Request, res: Response, appName: string): boolean {
  const actor = req.actor;
  if (actor === undefined) {
    sendRefusal(res, refusal('unauthenticated', 'You are not signed in.'));
    return false;
  }
  if (actor.type !== 'user') {
    sendRefusal(
      res,
      refusal('forbidden', 'Drift is resolved from the console, not with a token.', 'Sign in to the console as a deployer and resolve it there.'),
    );
    return false;
  }
  const denied = assertCanActOn(req, appName);
  if (denied !== null) {
    sendRefusal(res, denied);
    return false;
  }
  return true;
}

/** A digest map as the agent reported it: service → digest, or null for a stopped container. */
function observedOf(json: Prisma.JsonValue | null): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return out;
  for (const [service, digest] of Object.entries(json)) {
    out[service] = typeof digest === 'string' && digest.length > 0 ? digest : null;
  }
  return out;
}

/** The services the manifest maps to images, as the agent last reported it. */
function mappedServices(services: Prisma.JsonValue | null): string[] {
  if (typeof services !== 'object' || services === null || Array.isArray(services)) return [];
  return Object.keys(services).sort();
}

/** The drift event id the deployer reviewed, if the body names one. */
function reviewedEventId(body: unknown): string | undefined {
  const raw = typeof body === 'object' && body !== null ? (body as { driftEventId?: unknown }).driftEventId : undefined;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

const staleReview = (name: string): Refusal =>
  refusal(
    'conflict',
    `The drift you reviewed on ${name} is no longer the open one: it was resolved, or the agent has since observed different digests.`,
    'Reload the app, review what is running now, and choose again.',
  );

/** A pending redeploy's reason names the rollback it created: `… as deploy <uuid>.` */
const PENDING_DEPLOY_RE = /as deploy ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** Thrown inside the adopt transaction when the reviewed event was resolved meanwhile. */
class StaleReview extends Error {}

function repoOf(services: Prisma.JsonValue | null, service: string): string {
  if (typeof services !== 'object' || services === null || Array.isArray(services)) return '';
  const entry = (services as Record<string, unknown>)[service];
  if (typeof entry !== 'object' || entry === null) return '';
  const image = (entry as { image?: unknown }).image;
  return typeof image === 'string' ? image : '';
}

function serviceRows(observed: Prisma.JsonValue, recorded: Prisma.JsonValue) {
  const obs = typeof observed === 'object' && observed !== null && !Array.isArray(observed) ? observed : {};
  const rec = typeof recorded === 'object' && recorded !== null && !Array.isArray(recorded) ? recorded : {};
  const names = [...new Set([...Object.keys(obs), ...Object.keys(rec)])].sort();
  return names.map((service) => {
    const o = obs[service];
    const r = rec[service];
    const observedDigest = typeof o === 'string' ? o : null;
    const recordedDigest = typeof r === 'string' ? r : null;
    return {
      service,
      observed: observedDigest,
      recorded: recordedDigest,
      differs: observedDigest !== null && recordedDigest !== null && observedDigest !== recordedDigest,
    };
  });
}

/** Deploy's check for a redeploy of the recorded release: everything but the drift it resolves. */
const bypassDrift: DeployableCheck = async (db, appName) => {
  const r = await assertDeployable(db, appName);
  return r !== null && r.code === 'drift_unresolved' ? null : r;
};

export function mountDrift(router: Router, deps: ServiceDeps, readable: (req: Request, res: Response) => boolean): void {
  const { db } = deps;

  const notFound = (name: string) => refusal('not_found', `No app named ${name}.`, 'List the apps and use one of their names.');

  router.get('/:app/drift', async (req, res) => {
    if (!readable(req, res)) return;
    const name = req.params['app'];
    const scope = req.actor?.type === 'token' ? (req.tokenApps ?? new Set<string>()) : undefined;
    const row = scope !== undefined && !scope.has(name) ? null : await db.app.findUnique({ where: { name }, select: { id: true } });
    if (row === null) {
      sendRefusal(res, notFound(name));
      return;
    }
    const events = await db.driftEvent.findMany({
      where: { appId: row.id },
      orderBy: { detectedAt: 'desc' },
      take: 21,
      select: {
        id: true,
        observed: true,
        recorded: true,
        detectedAt: true,
        resolvedAt: true,
        resolution: true,
        reason: true,
        resolvedBy: { select: { email: true } },
      },
    });
    const open = events.find((e) => e.resolvedAt === null) ?? null;
    res.json({
      open:
        open === null
          ? null
          : {
              id: open.id,
              detectedAt: open.detectedAt.toISOString(),
              services: serviceRows(open.observed, open.recorded),
              // A redeploy-recorded was requested and runs, or ran and did not bring the recorded
              // release back; the event resolves when the agent reports the recorded release again.
              pending:
                open.resolution === 'redeploy_recorded'
                  ? {
                      deployId: PENDING_DEPLOY_RE.exec(open.reason ?? '')?.[1] ?? null,
                      requestedBy: open.resolvedBy?.email ?? null,
                      note: open.reason,
                    }
                  : null,
            },
      resolved: events
        .filter((e) => e.resolvedAt !== null)
        .slice(0, 20)
        .map((e) => ({
          id: e.id,
          detectedAt: e.detectedAt.toISOString(),
          resolvedAt: e.resolvedAt?.toISOString() ?? null,
          resolution: e.resolution,
          reason: e.reason,
          resolvedBy: e.resolvedBy?.email ?? null,
          services: serviceRows(e.observed, e.recorded),
        })),
    });
  });

  router.post('/:app/drift/adopt', async (req, res) => {
    const name = req.params['app'];
    if (!resolverOrRefuse(req, res, name)) return;
    const reason = parseReason(req.body);
    if (typeof reason !== 'string') {
      sendRefusal(res, reason);
      return;
    }
    const reviewed = reviewedEventId(req.body);
    const app = await db.app.findUnique({ where: { name }, select: { id: true, services: true, runningDigests: true } });
    if (app === null) {
      sendRefusal(res, notFound(name));
      return;
    }
    const [open, recorded] = await Promise.all([
      db.driftEvent.findFirst({
        where: { appId: app.id, resolvedAt: null },
        orderBy: { detectedAt: 'desc' },
        select: { id: true, observed: true, recorded: true },
      }),
      recordedRelease(db, app.id),
    ]);
    // Adopting establishes a recorded release: for an open drift, or for an app Shipyard has never deployed.
    if (open !== null) {
      if (reviewed === undefined) {
        sendRefusal(
          res,
          refusal(
            'invalid_request',
            'driftEventId is required to adopt: the id of the drift event whose digests you reviewed.',
            'Send { "reason": "…", "driftEventId": "<the open event\'s id>" }.',
          ),
        );
        return;
      }
      if (reviewed !== open.id) {
        sendRefusal(res, staleReview(name));
        return;
      }
    } else if (reviewed !== undefined) {
      sendRefusal(res, staleReview(name));
      return;
    } else if (recorded !== null) {
      sendRefusal(res, refusal('conflict', `${name} has no open drift to adopt.`, 'Nothing to resolve: what is running is the recorded release.'));
      return;
    }

    // What the deployer reviewed: the open event's observed digests (the banner), or, for an app
    // never deployed, what the agent last reported running (the page).
    const observed = observedOf(open !== null ? open.observed : app.runningDigests);
    const mapped = mappedServices(app.services);
    const services = mapped.length > 0 ? mapped : Object.keys(observed).sort();
    const stopped = services.filter((service) => observed[service] === undefined || observed[service] === null);
    if (services.length === 0 || stopped.length === services.length) {
      sendRefusal(
        res,
        refusal('conflict', `The agent has not reported a running container for ${name}.`, 'Start the app on the host, wait for the next agent report, then adopt.'),
      );
      return;
    }
    if (stopped.length > 0) {
      // A stopped service would be left out of the record, and could later start as anything unseen.
      sendRefusal(
        res,
        refusal(
          'conflict',
          `${stopped.join(', ')} of ${name} ${stopped.length === 1 ? 'has' : 'have'} no running container, so there is nothing to adopt for ${stopped.length === 1 ? 'it' : 'them'}.`,
          'Start every service on the host and wait for the next agent report, then review the drift again and adopt; or redeploy the recorded release.',
        ),
      );
      return;
    }
    const running: DigestMap = {};
    for (const service of services) running[service] = observed[service] ?? '';

    const locked = await lockRefusal(db, name, app.id);
    if (locked !== null) {
      sendRefusal(res, locked);
      return;
    }

    const recordedImages =
      recorded === null
        ? []
        : await db.targetImage.findMany({ where: { targetId: recorded.targetId }, select: { service: true, repo: true, sha: true, digest: true } });
    const images = services.map((service) => {
      const digest = running[service] ?? '';
      const same = recordedImages.find((i) => i.service === service);
      const known = same !== undefined && same.digest === digest;
      return {
        service,
        digest,
        repo: same?.repo ?? repoOf(app.services, service),
        sha: known ? same.sha : UNKNOWN_SHA,
      };
    });
    const allKnown = images.every((i) => i.sha !== UNKNOWN_SHA);
    const sha = allKnown && recorded !== null && recorded.sha !== null ? recorded.sha : UNKNOWN_SHA;
    const actor = req.actor;
    const email = actor?.label ?? 'unknown';
    const note = sha === UNKNOWN_SHA ? ' (source SHA unknown: recorded as 40 zeros)' : '';
    const label = `${ADOPT_LABEL_PREFIX}${email}: ${reason}${note}`;
    const now = new Date();
    const userId = actor?.id;

    let deployId: string;
    try {
      deployId = await db.$transaction(async (tx) => {
        // The event is resolved only if it is still the open one the deployer reviewed; a report
        // that superseded it, or another resolution, got there first.
        if (open !== null) {
          const resolved = await tx.driftEvent.updateMany({
            where: { id: open.id, resolvedAt: null },
            data: { resolvedAt: now, resolution: 'adopt_live', reason, ...(userId !== undefined ? { resolvedByUserId: userId } : {}) },
          });
          if (resolved.count !== 1) throw new StaleReview();
        } else if ((await recordedRelease(tx, app.id)) !== null) {
          throw new StaleReview();
        }
        const deploy = await tx.deploy.create({
          data: {
            kind: 'deploy',
            requestedSha: sha,
            requesterLabel: label,
            ...(userId !== undefined ? { requesterUser: { connect: { id: userId } } } : {}),
            targets: {
              create: {
                app: { connect: { id: app.id } },
                state: 'succeeded',
                currentStep: 'adopted',
                startedAt: now,
                endedAt: now,
                images: { create: images },
              },
            },
          },
          select: { id: true },
        });
        await clearDrifted(tx, app.id);
        return deploy.id;
      });
    } catch (err) {
      if (err instanceof StaleReview) {
        sendRefusal(res, staleReview(name));
        return;
      }
      throw err;
    }

    await req.audit({
      action: 'drift.adopted',
      entityType: 'app',
      entityId: app.id,
      before: { app: name, driftEventId: open?.id ?? null, observed: open?.observed ?? null, recorded: open?.recorded ?? recorded?.digests ?? null },
      after: { app: name, deployId, sha, reason, digests: running },
    });
    res.status(201).json({ deployId, sha, digests: running, driftEventId: open?.id ?? null });
  });

  router.post('/:app/drift/redeploy', async (req, res) => {
    const name = req.params['app'];
    if (!resolverOrRefuse(req, res, name)) return;
    const reviewed = reviewedEventId(req.body);
    const app = await db.app.findUnique({ where: { name }, select: { id: true } });
    if (app === null) {
      sendRefusal(res, notFound(name));
      return;
    }
    const open = await db.driftEvent.findFirst({
      where: { appId: app.id, resolvedAt: null },
      orderBy: { detectedAt: 'desc' },
      select: { id: true },
    });
    const recorded = await recordedRelease(db, app.id);
    if (open === null || recorded === null) {
      if (reviewed !== undefined) sendRefusal(res, staleReview(name));
      else sendRefusal(res, refusal('conflict', `${name} has no open drift to resolve.`, 'Nothing to redeploy: what is running is the recorded release.'));
      return;
    }
    if (reviewed !== undefined && reviewed !== open.id) {
      sendRefusal(res, staleReview(name));
      return;
    }
    // Only a release the agent deployed is in its ledger (SHP-D-080); an adopt-live record is not.
    if (!recorded.agentExecuted) {
      sendRefusal(
        res,
        refusal(
          'conflict',
          `${name}'s recorded release was adopted from the host, not deployed by the agent, so the agent has no release of it to redeploy.`,
          'Adopt what is running again, with a reason; then deploy a new SHA.',
        ),
      );
      return;
    }
    // The lock is never bypassed; only the drift this request resolves is.
    const result = await createDeploy(
      deps,
      callerFromRequest(req),
      { kind: 'rollback', app: name, toDeployId: recorded.deployId },
      { check: bypassDrift },
    );
    if (isRefusal(result)) {
      sendRefusal(res, result);
      return;
    }
    // Pending, not resolved: the drift is resolved (and deploys allowed again) only when the agent
    // next reports the recorded release running (`detectDrift`). Who asked, when, and the rollback
    // it created are kept on the event.
    const now = new Date();
    const userId = req.actor?.id;
    const note = `Redeploy of ${(recorded.sha ?? '').slice(0, 7) || 'the recorded release'} requested ${now.toISOString()} as deploy ${result.deployId}.`;
    await db.driftEvent.updateMany({
      where: { id: open.id, resolvedAt: null },
      data: { resolution: 'redeploy_recorded', reason: note, ...(userId !== undefined ? { resolvedByUserId: userId } : {}) },
    });
    await req.audit({
      action: 'drift.redeployed',
      entityType: 'app',
      entityId: app.id,
      before: { app: name, driftEventId: open.id },
      after: { app: name, deployId: result.deployId, toDeployId: recorded.deployId, sha: recorded.sha, pending: true },
    });
    res.status(201).json({ ...result, driftEventId: open.id, pending: true });
  });
}
