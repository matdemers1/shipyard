import type { Request, RequestHandler } from 'express';
import { refusal, type Refusal } from '@shipyard/schema';
import { sendRefusal } from '../errors.js';
import type { Role } from '../tokens/tokens.js';

export type { Role } from '../tokens/tokens.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * The role behind `req.actor`: the signed-in user's, or the token owner's. Set by
       * `authenticate`; absent for anonymous and agent requests.
       */
      role?: Role;
      /** For a bearer token, the app names it may act on (SHP-REQ-046). Absent for a user. */
      tokenApps?: ReadonlySet<string>;
    }
  }
}

/** Roles that may change state. `operator` is the same as `deployer` (SHP-REQ-065). */
export const STATE_CHANGING_ROLES: readonly Role[] = ['admin', 'operator', 'deployer'];

const NOT_SIGNED_IN = refusal('unauthenticated', 'You are not signed in.');

function viewerRefusal(): Refusal {
  return refusal(
    'forbidden',
    'The viewer role cannot change anything.',
    'Ask an admin for the deployer role.',
  );
}

/**
 * Null when the request's actor may make a state change that is not about one app; otherwise the
 * refusal. A viewer (or a token whose owner is a viewer) is refused (SHP-REQ-065).
 */
export function assertCanChangeState(req: Request): Refusal | null {
  const actor = req.actor;
  if (actor === undefined) return NOT_SIGNED_IN;
  if (actor.type !== 'user' && actor.type !== 'token') {
    return refusal('forbidden', `A ${actor.type} actor cannot make this change.`);
  }
  if (req.role === undefined || !STATE_CHANGING_ROLES.includes(req.role)) return viewerRefusal();
  return null;
}

/**
 * Null when the request's actor may act on `appName`; otherwise the refusal. A token must name
 * the app in its scope (SHP-REQ-047); a user must be a deployer, operator or admin.
 */
export function assertCanActOn(req: Request, appName: string): Refusal | null {
  const denied = assertCanChangeState(req);
  if (denied !== null) return denied;
  if (req.actor?.type === 'token' && req.tokenApps?.has(appName) !== true) {
    return refusal(
      'forbidden',
      `This token is not scoped to ${appName}.`,
      `Use a token issued for ${appName}, or issue a new one that names it.`,
    );
  }
  return null;
}

/** Refuses unless the actor is a user or token whose role is one of `roles`. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, res, next) => {
    if (req.actor === undefined) {
      sendRefusal(res, NOT_SIGNED_IN);
      return;
    }
    if (req.role === undefined || !roles.includes(req.role)) {
      sendRefusal(
        res,
        req.role === 'viewer'
          ? viewerRefusal()
          : refusal('forbidden', `This needs one of these roles: ${roles.join(', ')}.`),
      );
      return;
    }
    next();
  };
}
