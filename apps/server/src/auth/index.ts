import { Router, type RequestHandler } from 'express';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Db } from '../db.js';

// Stub, wired into app.ts by the fleet lead so SHP-T-0.5 never edits app.ts. SHP-T-0.5 replaces
// both bodies (and may change AuthDeps, which app.ts builds from AppDeps).
export interface AuthDeps {
  db: Db;
  logger: Logger;
  config: Config;
}

/** Resolves the session cookie or bearer token into `req.actor`, before any route runs. */
export function authenticate(_deps: AuthDeps): RequestHandler {
  return (_req, _res, next) => {
    next();
  };
}

/** Mounted at `/api/auth`. */
export function authRouter(_deps: AuthDeps): Router {
  return Router();
}
