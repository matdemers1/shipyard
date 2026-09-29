import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { Router, type Request, type RequestHandler, type Response } from 'express';
import { parseManifestYaml, refusal, type Refusal } from '@shipyard/schema';
import type { Actor } from '../audit.js';
import { actorForRequester, enqueueBuild, isRefusal, type BuildRequester } from '../builds/service.js';
import type { ServiceDeps } from '../deps.js';

/**
 * POST /api/webhooks/github (SHP-T-7.5): GitHub's push webhook for `build: shipyard` apps.
 *
 * - The signature is checked over the exact bytes GitHub sent (SHP-REQ-112), so this path gets its
 *   own raw body parser (`githubWebhookBody`, mounted in app.ts before the global JSON parser).
 * - A push to the default branch of an onboarded `build: shipyard` app enqueues one build of the
 *   pushed head; the answer is sent only after the enqueue committed (SHP-REQ-112).
 * - A missing or bad signature, a non-default ref, a deleted branch, a `build: github` app and a
 *   replayed delivery ID each enqueue nothing (SHP-REQ-113).
 * - Every delivery — accepted, ignored or refused — writes exactly one `webhook.github` audit event
 *   whose `after` names the delivery ID, event, repo, ref and outcome. Never the body, never the
 *   signature, never the secret.
 *
 * Replay: a delivery ID that was already verified and handled is refused as `replayed`. An in-memory
 * LRU catches it in this process; the audit table (`entity_type = 'webhook'`, `entity_id =
 * <delivery ID>`, indexed) catches it across restarts, and after the first build has finished. Only
 * a verified, handled delivery sets `entity_id`: a delivery that failed on our side (secret unset,
 * a bad signature) leaves it unset, so GitHub's "Redeliver" still works once that is fixed.
 */

export const WEBHOOK_AUDIT_ACTION = 'webhook.github';
export const WEBHOOK_ENTITY_TYPE = 'webhook';
export const WEBHOOK_ACTOR: Actor = { type: 'system', label: 'github-webhook' };
/** The largest body accepted; GitHub caps payloads at 25 MB but a push we care about is far smaller. */
export const WEBHOOK_BODY_LIMIT = '1mb';

const SIGNATURE_RE = /^sha256=([0-9a-f]{64})$/;
const DELIVERY_RE = /^[A-Za-z0-9-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const ZERO_SHA = '0'.repeat(40);
const REPLAY_MEMORY = 1000;

export type WebhookOutcome =
  | 'accepted'
  | 'ping'
  | 'ignored'
  | 'replayed'
  | 'not_configured'
  | 'bad_signature'
  | 'bad_request';

export type SkipReason =
  | 'not_default_branch'
  | 'branch_deleted'
  | 'invalid_sha'
  | 'not_built_by_shipyard'
  | 'manifest_invalid'
  | Refusal['code'];

interface WebhookRequest extends Request {
  webhookBodyError?: { status: number; type?: string };
}

/**
 * The raw-body parser for the webhook path: any content type, 1 MB. A parse failure (too large,
 * aborted) is left on the request for the route to record and answer, rather than falling through
 * to the generic 500 handler unrecorded.
 */
export function githubWebhookBody(): RequestHandler {
  const raw = express.raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT });
  return (req, res, next) => {
    raw(req, res, (err?: unknown) => {
      if (err !== undefined && err !== null) {
        const e = err as { status?: unknown; type?: unknown };
        (req as WebhookRequest).webhookBodyError = {
          status: typeof e.status === 'number' ? e.status : 400,
          ...(typeof e.type === 'string' ? { type: e.type } : {}),
        };
      }
      next();
    });
  };
}

/** True when `header` is `sha256=<hex>` of HMAC-SHA256(secret, body). Never throws. */
export function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (header === undefined) return false;
  const match = SIGNATURE_RE.exec(header.trim());
  const hex = match?.[1];
  if (hex === undefined) return false;
  const given = Buffer.from(hex, 'hex');
  const expected = createHmac('sha256', secret).update(body).digest();
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

/** A bounded, insertion-ordered set of recently handled delivery IDs. */
class RecentDeliveries {
  private readonly ids = new Set<string>();
  constructor(private readonly max: number) {}
  has(id: string): boolean {
    return this.ids.has(id);
  }
  add(id: string): void {
    this.ids.delete(id);
    this.ids.add(id);
    while (this.ids.size > this.max) {
      const oldest = this.ids.values().next().value;
      if (oldest === undefined) break;
      this.ids.delete(oldest);
    }
  }
  delete(id: string): void {
    this.ids.delete(id);
  }
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

interface PushPayload {
  ref: string | null;
  after: string | null;
  deleted: boolean;
  repo: string | null;
}

function readPush(body: unknown): PushPayload {
  const b = (body ?? {}) as Record<string, unknown>;
  const repository = (b['repository'] ?? {}) as Record<string, unknown>;
  return {
    ref: typeof b['ref'] === 'string' ? b['ref'] : null,
    after: typeof b['after'] === 'string' ? b['after'] : null,
    deleted: b['deleted'] === true,
    repo: typeof repository['full_name'] === 'string' ? repository['full_name'] : null,
  };
}

export interface WebhookRecord {
  deliveryId: string | null;
  event: string | null;
  repo?: string | null;
  ref?: string | null;
  sha?: string | null;
  outcome: WebhookOutcome;
  refusal?: Refusal['code'];
  builds?: { app: string; buildId: string; created: boolean }[];
  skipped?: { app: string; reason: SkipReason }[];
}

export function githubWebhookRouter(deps: ServiceDeps): Router {
  const { db, logger, config } = deps;
  const router = Router();
  const recent = new RecentDeliveries(REPLAY_MEMORY);

  /** One audit row per delivery. `handled` marks a verified delivery for replay detection. */
  async function record(req: Request, rec: WebhookRecord, handled: boolean): Promise<void> {
    await req.audit({
      action: WEBHOOK_AUDIT_ACTION,
      entityType: WEBHOOK_ENTITY_TYPE,
      ...(handled && rec.deliveryId !== null ? { entityId: rec.deliveryId } : {}),
      after: rec,
      actor: WEBHOOK_ACTOR,
    });
    logger.info({ deliveryId: rec.deliveryId, event: rec.event, repo: rec.repo, outcome: rec.outcome, refusal: rec.refusal }, 'github webhook');
  }

  async function refuse(req: Request, res: Response, status: number, r: Refusal, rec: WebhookRecord): Promise<void> {
    await record(req, { ...rec, refusal: r.code }, false);
    res.status(status).json({ error: r });
  }

  async function seenInAudit(deliveryId: string): Promise<boolean> {
    const row = await db.auditEvent.findFirst({
      where: { action: WEBHOOK_AUDIT_ACTION, entityType: WEBHOOK_ENTITY_TYPE, entityId: deliveryId },
      select: { id: true },
    });
    return row !== null;
  }

  router.post('/', async (req: WebhookRequest, res) => {
    const deliveryHeader = header(req, 'x-github-delivery');
    const deliveryId = deliveryHeader !== undefined && DELIVERY_RE.test(deliveryHeader) ? deliveryHeader : null;
    const eventHeader = header(req, 'x-github-event');
    const event = eventHeader !== undefined && /^[a-z_]{1,64}$/.test(eventHeader) ? eventHeader : null;
    const base: WebhookRecord = { deliveryId, event, outcome: 'bad_request' };

    const secret = config.GITHUB_WEBHOOK_SECRET;
    if (secret === undefined) {
      await refuse(
        req,
        res,
        503,
        refusal(
          'invalid_request',
          'GitHub webhooks are not configured on this Shipyard.',
          'Set GITHUB_WEBHOOK_SECRET in server.env to the webhook secret and restart the server.',
        ),
        { ...base, outcome: 'not_configured' },
      );
      return;
    }

    if (req.webhookBodyError !== undefined) {
      const tooLarge = req.webhookBodyError.status === 413;
      await refuse(
        req,
        res,
        tooLarge ? 413 : 400,
        refusal('invalid_request', tooLarge ? `The webhook body is larger than ${WEBHOOK_BODY_LIMIT}.` : 'The webhook body could not be read.'),
        base,
      );
      return;
    }

    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifySignature(secret, body, header(req, 'x-hub-signature-256'))) {
      await refuse(
        req,
        res,
        401,
        refusal(
          'unauthenticated',
          'The X-Hub-Signature-256 header is missing or does not match the body.',
          "Set the webhook's secret on GitHub to GITHUB_WEBHOOK_SECRET, with content type application/json.",
        ),
        { ...base, outcome: 'bad_signature' },
      );
      return;
    }

    if (deliveryId === null || event === null) {
      await refuse(req, res, 400, refusal('invalid_request', 'X-GitHub-Delivery and X-GitHub-Event are required.'), base);
      return;
    }

    // Claimed in memory before any await, so two concurrent copies of one delivery in this process
    // cannot both pass; the audit table covers restarts and builds that have since finished.
    const claimed = !recent.has(deliveryId);
    if (claimed) recent.add(deliveryId);
    if (!claimed || (await seenInAudit(deliveryId))) {
      await record(req, { ...base, outcome: 'replayed' }, false);
      res.status(200).json({ ok: true, replayed: true });
      return;
    }

    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        recent.delete(deliveryId);
        await refuse(req, res, 400, refusal('invalid_request', 'The webhook body is not JSON.', 'Set the webhook content type to application/json.'), base);
        return;
      }

      if (event === 'ping') {
        await record(req, { ...base, outcome: 'ping' }, true);
        res.status(200).json({ ok: true });
        return;
      }
      if (event !== 'push') {
        await record(req, { ...base, outcome: 'ignored' }, true);
        res.status(202).json({ ignored: true, event });
        return;
      }

      const push = readPush(parsed);
      const builds: NonNullable<WebhookRecord['builds']> = [];
      const skipped: NonNullable<WebhookRecord['skipped']> = [];
      const apps =
        push.repo === null
          ? []
          : await db.app.findMany({
              where: { repo: { equals: push.repo, mode: 'insensitive' } },
              select: { name: true, defaultBranch: true, manifestYaml: true },
              orderBy: { name: 'asc' },
            });

      for (const app of apps) {
        const reason = skipReason(app, push);
        if (reason !== null) {
          skipped.push({ app: app.name, reason });
          continue;
        }
        const sha = push.after as string;
        const requester: BuildRequester = { label: `github: push ${push.repo ?? ''}@${sha.slice(0, 7)}` };
        const actor = actorForRequester(requester);
        const result = await enqueueBuild(
          deps,
          { app: app.name, sha, trigger: 'webhook', requester },
          { actor, audit: (e) => req.audit({ ...e, actor }) },
        );
        if (isRefusal(result)) skipped.push({ app: app.name, reason: result.code });
        else builds.push({ app: app.name, buildId: result.buildId, created: result.created });
      }

      await record(req, { ...base, repo: push.repo, ref: push.ref, sha: push.after, outcome: 'accepted', builds, skipped }, true);
      res.status(202).json({ builds, skipped });
    } catch (err) {
      // A failure on our side must not make GitHub's redelivery look like a replay.
      recent.delete(deliveryId);
      throw err;
    }
  });

  return router;
}

function skipReason(
  app: { defaultBranch: string | null; manifestYaml: string },
  push: PushPayload,
): SkipReason | null {
  if (app.defaultBranch === null || push.ref !== `refs/heads/${app.defaultBranch}`) return 'not_default_branch';
  if (push.deleted || push.after === ZERO_SHA) return 'branch_deleted';
  if (push.after === null || !SHA_RE.test(push.after)) return 'invalid_sha';
  try {
    if (parseManifestYaml(app.manifestYaml).build?.source !== 'shipyard') return 'not_built_by_shipyard';
  } catch {
    return 'manifest_invalid';
  }
  return null;
}
