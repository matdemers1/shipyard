import { Router, type Request, type Response } from 'express';
import type { z } from 'zod';
import { PruneRequest, VolumeBackupRequest, VolumeDeleteRequest, VolumeName, VolumeRestoreRequest, refusal, type Refusal } from '@shipyard/schema';
import { STEP_UP_MS } from '../auth/native-sessions.js';
import type { Db } from '../db.js';
import type { ServiceDeps } from '../deps.js';
import { callerFromRequest } from '../deploys/service.js';
import { sendRefusal } from '../errors.js';
import {
  destructiveRefusal,
  getMaintenance,
  isMaintenanceTerminal,
  listMaintenance,
  listVolumeArchives,
  maintenanceInScope,
  maintenanceNeedsYou,
  requestPrune,
  requestVolumeBackup,
  requestVolumeDelete,
  requestVolumeRestore,
  sweepStaleMaintenance,
  waitForMaintenance,
} from './service.js';

export * from './service.js';
export * from './lock.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_WAIT_SECONDS = 90;
const NO_SUCH_JOB = refusal('not_found', 'No such maintenance job.', 'List maintenance jobs and use one of their IDs.');

/**
 * Null when the session making the request stepped up within the last ten minutes; otherwise
 * `step_up_required` (SHP-REQ-202, SHP-REQ-203, SHP-ADR-012). Unlike `staleStepUp`, which asks it
 * of native sessions only, a volume restore or delete asks it of every session: the console's
 * cookie session and a native one (D3 Constellation) alike. A person on D3 Constellation with a
 * fresh step-up counts as a person, the same as for approvals there (SHP-ADR-012), so a native
 * session with a fresh step-up may restore and delete; an API token never can, whatever its
 * owner's role (SHP-REQ-204, refused before this runs). The row's `step_up_at` is read fresh for
 * either kind, so a step-up taken a moment ago in another tab counts.
 */
export async function requireFreshStepUp(db: Db, req: Request, now: number = Date.now()): Promise<Refusal | null> {
  const sessionId = req.nativeSession?.id ?? req.consoleSessionId;
  const stale = refusal(
    'step_up_required',
    'Confirm it’s you before restoring or deleting a volume.',
    'Enter a code from your authenticator, then retry within ten minutes.',
  );
  if (sessionId === undefined) return stale;
  const row = await db.session.findUnique({ where: { id: sessionId }, select: { stepUpAt: true } });
  if (row === null || row.stepUpAt === null) return stale;
  return now - row.stepUpAt.getTime() <= STEP_UP_MS ? null : stale;
}

/** Reading needs a signed-in user (any role) or a token. */
function readRefusal(req: Request): Refusal | null {
  const type = req.actor?.type;
  if (type === 'user' || type === 'token') return null;
  if (type === undefined) return refusal('unauthenticated', 'You are not signed in.');
  return refusal('forbidden', `A ${type} actor cannot read maintenance jobs.`);
}

function tokenScope(req: Request): { apps: ReadonlySet<string>; stacks: ReadonlySet<string> } | undefined {
  return req.actor?.type === 'token' ? { apps: req.tokenApps ?? new Set<string>(), stacks: req.tokenStacks ?? new Set<string>() } : undefined;
}

function parseBody<T extends z.ZodType>(schema: T, req: Request, res: Response, what: string): z.infer<T> | null {
  const parsed = schema.safeParse(req.body ?? {});
  if (parsed.success) return parsed.data;
  sendRefusal(
    res,
    refusal(
      'invalid_request',
      `The ${what} request failed validation.`,
      parsed.error.issues.map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; '),
    ),
  );
  return null;
}

/** The `:volume` path parameter, or the refusal already sent. */
function volumeParam(req: Request, res: Response): string | null {
  const raw: unknown = req.params['volume'];
  const parsed = VolumeName.safeParse(raw);
  if (parsed.success) return parsed.data;
  sendRefusal(res, refusal('invalid_request', 'That is not a Docker volume name.', 'Use a volume name from the host inventory.'));
  return null;
}

function idParam(req: Request): string {
  const raw: unknown = req.params['id'];
  return typeof raw === 'string' ? raw : '';
}

/**
 * Mounted at `/api` (SHP-T-17.3; SHP-ADR-012, SHP-REQ-201..205):
 *
 * - `POST /volumes/:volume/backup` — deployer and up, or a token scoped to the owner.
 * - `POST /volumes/:volume/restore`, `POST /volumes/:volume/delete` (and `DELETE /volumes/:volume`)
 *   — an admin in the console with a step-up from the last ten minutes and the name typed back;
 *   never a token (SHP-REQ-204). Every refused attempt by a known caller is audited
 *   `maintenance.refused`, naming who tried.
 * - `GET /volumes/:volume/archives` — the volume's unretired archives, newest first.
 * - `POST /prune` — a dry run, or a prune that follows one (deployer and up, any token).
 * - `GET /maintenance` — every job, newest first (a token: its owners and prunes).
 * - `GET /maintenance/needs-you` — failed backups and low disk (console users).
 * - `GET /maintenance/:id?wait=` — one job, waiting up to 90 s for it to end.
 */
export function maintenanceRouter(deps: ServiceDeps): Router {
  const { db } = deps;
  const router = Router();

  router.post('/volumes/:volume/backup', async (req, res) => {
    const volume = volumeParam(req, res);
    if (volume === null) return;
    if (parseBody(VolumeBackupRequest, req, res, 'volume backup') === null) return;
    const result = await requestVolumeBackup(deps, callerFromRequest(req), volume);
    if ('code' in result) {
      sendRefusal(res, result);
      return;
    }
    res.status(202).json(result);
  });

  /** Audits a refused restore or delete when someone known tried it, then sends the refusal. */
  const refuse = async (req: Request, res: Response, kind: 'volume-restore' | 'volume-delete', volume: string, why: Refusal, extra: Record<string, unknown> = {}): Promise<void> => {
    if (req.actor !== undefined) {
      await req.audit({
        action: 'maintenance.refused',
        entityType: 'volume',
        entityId: volume,
        after: { kind, volume, code: why.code, message: why.message, ...extra },
      });
    }
    sendRefusal(res, why, why.code === 'step_up_required' ? { maxAgeSeconds: STEP_UP_MS / 1000 } : {});
  };

  router.post('/volumes/:volume/restore', async (req, res) => {
    const volume = volumeParam(req, res);
    if (volume === null) return;
    const caller = callerFromRequest(req);
    // Who may, before anything else: a token learns nothing about the volume (SHP-REQ-204).
    const denied = destructiveRefusal(caller, 'restore') ?? (await requireFreshStepUp(db, req));
    if (denied !== null) {
      await refuse(req, res, 'volume-restore', volume, denied);
      return;
    }
    const body = parseBody(VolumeRestoreRequest, req, res, 'volume restore');
    if (body === null) return;
    const result = await requestVolumeRestore(deps, caller, volume, body);
    if ('code' in result) {
      await refuse(req, res, 'volume-restore', volume, result, { archiveId: body.archiveId });
      return;
    }
    res.status(202).json(result);
  });

  const del = async (req: Request, res: Response): Promise<void> => {
    const volume = volumeParam(req, res);
    if (volume === null) return;
    const caller = callerFromRequest(req);
    const denied = destructiveRefusal(caller, 'delete') ?? (await requireFreshStepUp(db, req));
    if (denied !== null) {
      await refuse(req, res, 'volume-delete', volume, denied);
      return;
    }
    const body = parseBody(VolumeDeleteRequest, req, res, 'volume delete');
    if (body === null) return;
    const result = await requestVolumeDelete(deps, caller, volume, body);
    if ('code' in result) {
      await refuse(req, res, 'volume-delete', volume, result);
      return;
    }
    res.status(202).json(result);
  };
  router.post('/volumes/:volume/delete', del);
  router.delete('/volumes/:volume', del);

  router.get('/volumes/:volume/archives', async (req, res) => {
    const denied = readRefusal(req);
    if (denied !== null) {
      sendRefusal(res, denied);
      return;
    }
    const volume = volumeParam(req, res);
    if (volume === null) return;
    res.json({ archives: await listVolumeArchives(db, volume, tokenScope(req)) });
  });

  router.post('/prune', async (req, res) => {
    const body = parseBody(PruneRequest, req, res, 'prune');
    if (body === null) return;
    const result = await requestPrune(deps, callerFromRequest(req), body);
    if ('code' in result) {
      sendRefusal(res, result);
      return;
    }
    res.status(202).json(result);
  });

  router.get('/maintenance', async (req, res) => {
    const denied = readRefusal(req);
    if (denied !== null) {
      sendRefusal(res, denied);
      return;
    }
    const raw = req.query['limit'];
    let limit = DEFAULT_LIMIT;
    if (raw !== undefined) {
      if (typeof raw !== 'string' || !/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > MAX_LIMIT) {
        sendRefusal(res, refusal('invalid_request', `limit must be a whole number from 1 to ${String(MAX_LIMIT)}.`));
        return;
      }
      limit = Number(raw);
    }
    const cursor = req.query['cursor'];
    if (cursor !== undefined && typeof cursor !== 'string') {
      sendRefusal(res, refusal('invalid_request', 'cursor must be a string.'));
      return;
    }
    await sweepStaleMaintenance(deps);
    const scope = tokenScope(req);
    res.json(await listMaintenance(db, { limit, ...(cursor === undefined ? {} : { cursor }), ...(scope === undefined ? {} : { scope }) }));
  });

  router.get('/maintenance/needs-you', async (req, res) => {
    if (req.actor === undefined) {
      sendRefusal(res, refusal('unauthenticated', 'You are not signed in.'));
      return;
    }
    if (req.actor.type !== 'user') {
      sendRefusal(res, refusal('forbidden', 'What needs you is read in the console.'));
      return;
    }
    await sweepStaleMaintenance(deps);
    res.json(await maintenanceNeedsYou(db));
  });

  router.get('/maintenance/:id', async (req, res) => {
    const denied = readRefusal(req);
    if (denied !== null) {
      sendRefusal(res, denied);
      return;
    }
    const rawWait = req.query['wait'];
    let wait = 0;
    if (rawWait !== undefined) {
      if (typeof rawWait !== 'string' || !/^\d+$/.test(rawWait) || Number(rawWait) > MAX_WAIT_SECONDS) {
        sendRefusal(res, refusal('invalid_request', `wait must be a whole number of seconds from 0 to ${String(MAX_WAIT_SECONDS)}.`));
        return;
      }
      wait = Number(rawWait);
    }
    const id = idParam(req);
    const first = await getMaintenance(db, id);
    // Scope is checked before waiting, so an out-of-scope caller cannot hold a long poll open.
    if (first === null || !maintenanceInScope(callerFromRequest(req), first)) {
      sendRefusal(res, first === null ? NO_SUCH_JOB : refusal('forbidden', 'This token is not scoped to what this job works on.'));
      return;
    }
    if (isMaintenanceTerminal(first.state)) {
      res.json(first);
      return;
    }
    if (wait === 0) {
      // Not yet ended: give the stale sweep its chance, so an agent that went away shows as failed.
      const swept = await sweepStaleMaintenance(deps);
      res.json(swept.includes(first.id) ? ((await getMaintenance(db, id)) ?? first) : first);
      return;
    }
    const gone = new AbortController();
    const onClose = (): void => {
      gone.abort();
    };
    res.on('close', onClose);
    try {
      const status = await waitForMaintenance(deps, id, wait * 1000, gone.signal);
      if (!gone.signal.aborted) res.json(status ?? first);
    } finally {
      res.off('close', onClose);
    }
  });

  return router;
}
