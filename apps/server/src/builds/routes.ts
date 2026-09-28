import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { AppName, Sha40, refusal, type Refusal } from '@shipyard/schema';
import { assertCanActOn } from '../auth/scope.js';
import type { Db } from '../db.js';
import type { ServiceDeps } from '../deps.js';
import { sendRefusal } from '../errors.js';
import {
  enqueueBuild,
  getBuild,
  getBuildLogs,
  isRefusal,
  listBuilds,
  rebuild,
  requestCancel,
  type BuildCaller,
  type BuildDetail,
  type BuildRequester,
} from './service.js';

/**
 * `/api/builds` (SHP-T-7.4): list and read builds (viewer and up; a token only its apps), queue a
 * build, rebuild and cancel (deployer and up; a token only its apps). Every mutation is audited
 * by the service through `req.audit` (SHP-REQ-148).
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const NO_SUCH_BUILD = refusal('not_found', 'No such build.', 'List builds and use one of their IDs.');
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** `POST /api/builds`. A session's build is `manual`; MCP queues through its own tool as `mcp`. */
export const BuildRequestBody = z.strictObject({
  app: AppName,
  sha: Sha40,
  requester: z
    .strictObject({
      label: z
        .string()
        .min(1)
        .max(200)
        .regex(/^[^\p{Cc}]*$/u, 'no control characters'),
    })
    .optional(),
});

const RebuildBody = z.strictObject({ requester: BuildRequestBody.shape.requester }).optional();

/** Reading needs a signed-in user (any role) or a token; a token reads only its scoped apps. */
export function readRefusal(req: Request, app: string | null): Refusal | null {
  const type = req.actor?.type;
  if (type === undefined) return refusal('unauthenticated', 'You are not signed in.');
  if (type !== 'user' && type !== 'token') return refusal('forbidden', `A ${type} actor cannot read builds.`);
  if (app !== null && type === 'token' && req.tokenApps?.has(app) !== true) {
    return refusal('forbidden', `This token is not scoped to ${app}.`, `Use a token issued for ${app}.`);
  }
  return null;
}

/** The build named by `:id` once the caller may read it; otherwise the refusal has been sent. */
export async function readableBuild(db: Db, req: Request, res: Response): Promise<BuildDetail | null> {
  const denied = readRefusal(req, null);
  if (denied !== null) {
    sendRefusal(res, denied);
    return null;
  }
  const raw: unknown = req.params['id'];
  const id = typeof raw === 'string' ? raw : '';
  if (!UUID_RE.test(id)) {
    sendRefusal(res, NO_SUCH_BUILD);
    return null;
  }
  const build = await getBuild(db, id);
  if (build === null) {
    sendRefusal(res, NO_SUCH_BUILD);
    return null;
  }
  const scoped = readRefusal(req, build.app);
  if (scoped !== null) {
    sendRefusal(res, scoped);
    return null;
  }
  return build;
}

function validationRefusal(error: z.ZodError, what: string): Refusal {
  return refusal(
    'invalid_request',
    `The ${what} failed validation.`,
    error.issues.map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; '),
  );
}

/** Who is asking, from the request: the requester row links and the request's audit writer. */
function requesterFrom(req: Request, label: string | undefined): { requester: BuildRequester; caller: BuildCaller } {
  // assertCanActOn has already established a user or token actor.
  const actor = req.actor ?? { type: 'system' as const, label: 'anonymous' };
  const requester: BuildRequester = {
    label: label ?? (actor.type === 'user' ? `${actor.label} (console)` : actor.label),
    ...(actor.type === 'user' && actor.id !== undefined ? { userId: actor.id } : {}),
    ...(actor.type === 'token' && actor.id !== undefined ? { tokenId: actor.id } : {}),
  };
  return { requester, caller: { actor, audit: (event) => req.audit(event) } };
}

function intParam(raw: unknown, fallback: number, min: number, max: number): number | null {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n < min || n > max ? null : n;
}

/** Mounted at `/api/builds`, after `buildEventsRouter`. */
export function buildsRouter(deps: ServiceDeps): Router {
  const { db } = deps;
  const router = Router();

  router.get('/', async (req, res) => {
    const denied = readRefusal(req, null);
    if (denied !== null) {
      sendRefusal(res, denied);
      return;
    }
    const limit = intParam(req.query['limit'], DEFAULT_LIMIT, 1, MAX_LIMIT);
    if (limit === null) {
      sendRefusal(res, refusal('invalid_request', `limit must be a whole number from 1 to ${String(MAX_LIMIT)}.`));
      return;
    }
    const rawCursor = req.query['cursor'];
    if (rawCursor !== undefined && (typeof rawCursor !== 'string' || !/^\d{1,19}$/.test(rawCursor))) {
      sendRefusal(res, refusal('invalid_request', 'cursor must be a nextCursor from an earlier page.'));
      return;
    }
    const rawApp = req.query['app'];
    let app: string | undefined;
    if (rawApp !== undefined) {
      const name = AppName.safeParse(rawApp);
      if (!name.success) {
        sendRefusal(res, refusal('invalid_request', 'app must be an app name.'));
        return;
      }
      app = name.data;
      const scoped = readRefusal(req, app);
      if (scoped !== null) {
        sendRefusal(res, scoped);
        return;
      }
    }
    const page = await listBuilds(db, {
      limit,
      ...(app !== undefined ? { app } : {}),
      ...(req.actor?.type === 'token' ? { apps: req.tokenApps ?? new Set<string>() } : {}),
      ...(typeof rawCursor === 'string' ? { cursor: rawCursor } : {}),
    });
    res.json(page);
  });

  router.post('/', async (req, res) => {
    const parsed = BuildRequestBody.safeParse(req.body);
    if (!parsed.success) {
      sendRefusal(res, validationRefusal(parsed.error, 'build request'));
      return;
    }
    const denied = assertCanActOn(req, parsed.data.app);
    if (denied !== null) {
      sendRefusal(res, denied);
      return;
    }
    const { requester, caller } = requesterFrom(req, parsed.data.requester?.label);
    const result = await enqueueBuild(deps, { app: parsed.data.app, sha: parsed.data.sha, trigger: 'manual', requester }, caller);
    if (isRefusal(result)) {
      sendRefusal(res, result);
      return;
    }
    res.status(result.created ? 201 : 200).json(result);
  });

  router.get('/:id', async (req, res) => {
    const build = await readableBuild(db, req, res);
    if (build === null) return;
    res.json(build);
  });

  router.get('/:id/logs', async (req, res) => {
    const rawAfter = req.query['after'];
    if (rawAfter !== undefined && (typeof rawAfter !== 'string' || !/^\d{1,19}$/.test(rawAfter))) {
      sendRefusal(res, refusal('invalid_request', 'after must be a log id.'));
      return;
    }
    const build = await readableBuild(db, req, res);
    if (build === null) return;
    const logs = await getBuildLogs(db, build.buildId, typeof rawAfter === 'string' ? { afterId: BigInt(rawAfter) } : {});
    res.json({ logs });
  });

  /** Rebuild and cancel act on an existing build: its app decides scope. */
  async function actOn(req: Request, res: Response): Promise<{ buildId: string; label: string | undefined } | null> {
    const body = RebuildBody.safeParse(req.body ?? undefined);
    if (!body.success) {
      sendRefusal(res, validationRefusal(body.error, 'request'));
      return null;
    }
    const raw: unknown = req.params['id'];
    const id = typeof raw === 'string' ? raw : '';
    const anyone = readRefusal(req, null);
    if (anyone !== null) {
      sendRefusal(res, anyone);
      return null;
    }
    const row = UUID_RE.test(id) ? await db.build.findUnique({ where: { id }, select: { app: { select: { name: true } } } }) : null;
    if (row === null) {
      sendRefusal(res, NO_SUCH_BUILD);
      return null;
    }
    const denied = assertCanActOn(req, row.app.name);
    if (denied !== null) {
      sendRefusal(res, denied);
      return null;
    }
    return { buildId: id, label: body.data?.requester?.label };
  }

  router.post('/:id/rebuild', async (req, res) => {
    const target = await actOn(req, res);
    if (target === null) return;
    const { requester, caller } = requesterFrom(req, target.label);
    const result = await rebuild(deps, target.buildId, requester, caller);
    if (isRefusal(result)) {
      sendRefusal(res, result);
      return;
    }
    res.status(201).json(result);
  });

  router.post('/:id/cancel', async (req, res) => {
    const target = await actOn(req, res);
    if (target === null) return;
    const { caller } = requesterFrom(req, target.label);
    const result = await requestCancel(deps, target.buildId, caller);
    if (isRefusal(result)) {
      sendRefusal(res, result);
      return;
    }
    res.json(result);
  });

  return router;
}
