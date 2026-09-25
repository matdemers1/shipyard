import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Logger } from 'pino';
import type { Db } from './db.js';

/** Who did it, for the audit trail (SHP-REQ-006). `authenticate` (src/auth) sets `req.actor`. */
export interface Actor {
  type: 'user' | 'token' | 'agent' | 'system';
  id?: string;
  label: string;
}

export interface AuditEventInput {
  action: string;
  entityType: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  /**
   * Who did it, when `req.actor` does not say. Unauthenticated routes (login) pass the account
   * they just resolved, or `{ type: 'system', label: 'anonymous' }` explicitly for a failed
   * attempt. Takes precedence over `req.actor`.
   */
  actor?: Actor;
}

declare global {
  // This is how Express's own types (and every consumer that augments Request) extend it; there
  // is no module-syntax equivalent.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: Actor;
      audit(event: AuditEventInput): Promise<void>;
      /** Marks a POST that changes nothing worth recording; the reason is logged at debug. */
      noAuditNeeded(reason: string): void;
    }
  }
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The explicit actor for an unauthenticated attempt (a failed login). Never a silent fallback. */
export const ANONYMOUS_ACTOR: Actor = { type: 'system', label: 'anonymous' };

/** Thrown by `req.audit` when neither the event nor the request names an actor. */
export class MissingActorError extends Error {
  constructor(action: string) {
    super(`req.audit("${action}") called with no actor: set req.actor or pass event.actor`);
    this.name = 'MissingActorError';
  }
}

export interface AuditContextOptions {
  onUnauditedMutation?: (info: { method: string; path: string; requestId: string }) => void;
}

/**
 * Assigns a request ID, attaches `req.audit`, and — for mutating methods that finish 2xx without
 * having audited anything — reports it via `onUnauditedMutation` (SHP-REQ-006). The guard trusts
 * a per-request flag set by `req.audit`, not a query after the fact, so it cannot race a
 * concurrent request's audit rows.
 */
export function auditContext(db: Db, logger: Logger, options: AuditContextOptions = {}): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.headers['x-request-id'];
    const candidate = typeof incoming === 'string' ? incoming : undefined;
    const requestId = candidate !== undefined && REQUEST_ID_RE.test(candidate) ? candidate : randomUUID();
    res.setHeader('x-request-id', requestId);

    let audited = false;

    // A POST that changes nothing meaningful (a heartbeat, a read over MCP, an unchanged report)
    // says so, with a reason, instead of tripping the unaudited-mutation guard or writing noise.
    req.noAuditNeeded = (reason: string): void => {
      audited = true;
      logger.debug({ requestId, reason }, 'no audit needed');
    };

    req.audit = async (event: AuditEventInput): Promise<void> => {
      // No fallback: an authenticated mutation that forgot its actor must fail loudly rather than
      // be attributed to "anonymous system".
      const actor = event.actor ?? req.actor;
      if (actor === undefined) throw new MissingActorError(event.action);
      await db.auditEvent.create({
        data: {
          actorType: actor.type,
          ...(actor.type === 'user' && actor.id !== undefined ? { actorUserId: actor.id } : {}),
          ...(actor.type === 'token' && actor.id !== undefined ? { actorTokenId: actor.id } : {}),
          ...(actor.type === 'agent' && actor.id !== undefined ? { actorAgentId: actor.id } : {}),
          actorLabel: actor.label,
          action: event.action,
          entityType: event.entityType,
          ...(event.entityId !== undefined ? { entityId: event.entityId } : {}),
          ...(event.before !== undefined ? { before: event.before as object } : {}),
          ...(event.after !== undefined ? { after: event.after as object } : {}),
          ...(req.ip !== undefined ? { ip: req.ip } : {}),
          requestId,
        },
      });
      audited = true;
    };

    res.on('finish', () => {
      if (
        MUTATING_METHODS.has(req.method) &&
        res.statusCode >= 200 &&
        res.statusCode < 300 &&
        !audited
      ) {
        logger.error({ method: req.method, path: req.path, requestId }, 'mutation without audit');
        options.onUnauditedMutation?.({ method: req.method, path: req.path, requestId });
      }
    });

    next();
  };
}
