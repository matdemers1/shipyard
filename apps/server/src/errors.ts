import type { NextFunction, Request, Response } from 'express';
import { CATALOGUE, refusal, type Refusal } from '@shipyard/schema';
import type { Logger } from 'pino';
import { ZodError } from 'zod';

/** Sends the refusal envelope with the catalogue's HTTP status for its code (SHP-REQ-031). */
export function sendRefusal(res: Response, r: Refusal): void {
  const status = CATALOGUE[r.code].httpStatus;
  res.status(status).json({ error: r });
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
