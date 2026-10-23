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
 * A body-parser error (http-errors with a `type` such as `entity.parse.failed` and a 4xx status).
 * body-parser attaches the raw request body to a parse failure as `err.body`: it must never reach
 * a log (SHP-REQ-191 — an agent's log chunk is someone's log lines).
 */
export function bodyParserError(err: unknown): { type: string; status: number } | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as { type?: unknown; status?: unknown; statusCode?: unknown };
  const status = typeof e.status === 'number' ? e.status : e.statusCode;
  if (typeof e.type !== 'string' || typeof status !== 'number' || status < 400 || status > 499) return null;
  return { type: e.type, status };
}

/**
 * What of an error may be logged: everything but a `body` (a request body some library hung on
 * it), with name, message and stack kept so pino's error serializer still renders it.
 */
export function loggableError(err: unknown): unknown {
  if (typeof err !== 'object' || err === null) return err;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(err)) {
    if (k !== 'body') out[k] = v;
  }
  if (err instanceof Error) {
    out['name'] = err.name;
    out['message'] = err.message;
    out['stack'] = err.stack;
  }
  return out;
}

/** A body that could not be read, as a refusal with the parser's own status (400, 413, 415). */
export function sendUnreadableBody(res: Response, status: number, type: string): void {
  const r =
    type === 'entity.too.large'
      ? refusal('invalid_request', 'The request body is too large.', 'Send a smaller body.')
      : refusal('invalid_request', 'The request body could not be read as JSON.', 'Send a well-formed JSON body with content-type application/json.');
  const req = res.req as Request | undefined;
  if (req !== undefined && wantsProblems(req)) {
    sendProblem(res, status, r);
    return;
  }
  res.status(status).json({ error: r });
}

/**
 * Express error handler: a ZodError becomes `invalid_request`; a body the JSON parser could not
 * read becomes `invalid_request` with the parser's status, logged as its type and status only;
 * anything else is logged without any `body` it carries (never the stack in the response) and
 * answered with a generic 500.
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
    const unreadable = bodyParserError(err);
    if (unreadable !== null) {
      logger.warn({ type: unreadable.type, status: unreadable.status }, 'request body refused by the JSON parser');
      sendUnreadableBody(res, unreadable.status, unreadable.type);
      return;
    }
    logger.error({ err: loggableError(err) }, 'unhandled error');
    sendInternalError(res);
  };
}
