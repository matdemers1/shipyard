import { Router } from 'express';
import { HealthResponse } from '@shipyard/schema';
import type { Db } from '../db.js';
import { getSchemaRevision } from '../schema-revision.js';

/** GET /api/health — unauthenticated, so it works before anything else does. */
export function healthRouter(db: Db, version: string): Router {
  const router = Router();

  router.get('/health', (_req, res, next) => {
    getSchemaRevision(db)
      .then((schemaRevision) => {
        res.status(200).json(HealthResponse.parse({ status: 'ok', schemaRevision, version }));
      })
      .catch((err: unknown) => {
        next(err);
      });
  });

  return router;
}
