import type { NextFunction, Request, Response } from 'express';
import { CATALOGUE, refusal, type Refusal } from '@shipyard/schema';
import type { Logger } from 'pino';
import { ZodError } from 'zod';

const PROBLEMS = 'https://d3cloud.io/problems/';

/** Our codes that the D3 App contract registers, by the registry's name. */
const REGISTERED: Partial<Record<Refusal['code'], string>> = {
  unauthenticated: 'session_revoked',
  too_many_attempts: 'throttled',
  forbidden: 'forbidden_role',
  step_up_required: 'step_up_required',
};

/**
 * A native client's request (SHP-P-10): a Bearer token that is not an `shp_` API token, or a
 * client that asks for problems by name. The console and API-token callers keep the envelope.
 */
export function wantsProblems(req: Request): boolean {
  const authorization = req.get('authorization') ?? '';
  const bearer = /^Bearer (\S+)$/i.exec(authorization.trim())?.[1];
  return (
    (bearer !== undefined && !bearer.startsWith('shp_')) ||
    (req.get('accept') ?? '').includes('application/problem+json') ||
    req.originalUrl.startsWith('/api/auth/native/')
  );
}

/** A refusal as RFC 9457, with Shipyard's code, gate and fix carried along (the D3 App contract). */
export function sendProblem(res: Response, status: number, r: Refusal, extra: Record<string, unknown> = {}): void {
  const name = REGISTERED[r.code];
  res
    .status(status)
    .type('application/problem+json')
    .send(
      JSON.stringify({
        type: name === undefined ? 'about:blank' : `${PROBLEMS}${name}`,
        title: r.message,
        status,
        detail: r.fix,
        code: r.code,
        gate: r.gate,
        ...extra,
      }),
    );
}

/**
 * Sends the refusal envelope with the catalogue's HTTP status for its code (SHP-REQ-031) — or, to a
 * native client, the same refusal as problem+json.
 */
export function sendRefusal(res: Response, r: Refusal, extra: Record<string, unknown> = {}): void {
  const status = CATALOGUE[r.code].httpStatus;
  // A response built outside a request (the unit tests' fakes) has no req to ask.
  const req = res.req as Request | undefined;
  if (req !== undefined && wantsProblems(req)) {
    sendProblem(res, status, r, extra);
    return;
  }
  res.status(status).json({ error: r, ...extra });
}

/**
 * Sends a 500 with a generic refusal shape. Not backed by the catalogue (there is no
 * "internal_error" gate code): an unhandled error is never a gate refusal.
 */
function sendInternalError(res: Response): void {
  res.status(500).json({
    error: {
      code: 'invalid_request',
      gate: 'none',
      message: 'An unexpected error occurred.',
      fix: 'Try again; if this persists, contact an operator.',
    },
  });
}

/**
 * Express error handler: a ZodError becomes `invalid_request`; anything else is logged (never
 * the stack in the response) and answered with a generic 500.
 */
export function errorHandler(logger: Logger) {
  return (err: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof ZodError) {
      sendRefusal(
        res,
        refusal('invalid_request', 'The request failed validation.', err.issues.map((i) => i.message).join('; ')),
      );
      return;
    }
    logger.error({ err }, 'unhandled error');
    sendInternalError(res);
  };
}
