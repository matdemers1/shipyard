import express, { type Express, type Router } from 'express';
import { refusal } from '@shipyard/schema';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { auditContext, type AuditContextOptions } from './audit.js';
import type { Db } from './db.js';
import { errorHandler, sendRefusal } from './errors.js';
import { healthRouter } from './routes/health.js';

export interface AppDeps {
  db: Db;
  logger: Logger;
  config: Config;
  onUnauditedMutation?: AuditContextOptions['onUnauditedMutation'];
  /**
   * Test-only seam: a router mounted at `/api/_test` before the 404 handler, so integration
   * tests can exercise `req.audit`/`req.actor` and the unaudited-mutation guard without a real
   * feature router. Never set in production.
   */
  testRouter?: Router;
}

/** Builds the Express app (SHP-T-0.4). Later tasks mount routers in the section marked below. */
export function createApp(deps: AppDeps): Express {
  const { db, logger, config, onUnauditedMutation, testRouter } = deps;

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1_000_000;
      logger.info(
        { method: req.method, path: req.path, status: res.statusCode, ms, requestId: res.getHeader('x-request-id') },
        'request',
      );
    });
    next();
  });

  app.use(auditContext(db, logger, onUnauditedMutation === undefined ? {} : { onUnauditedMutation }));

  app.use('/api', healthRouter(db, config.SHIPYARD_VERSION));

  // ── Registration section ──────────────────────────────────────────────
  // Later tasks mount their routers here, before the 404 handler below:
  //   app.use('/api/auth', authRouter(...));      // login/session/tokens
  //   app.use('/api/openapi.json', openapiRouter); // generated OpenAPI document
  //   app.use('/api', deploysRouter(...));         // deploy request/status/rollback
  // ─────────────────────────────────────────────────────────────────────

  if (testRouter !== undefined) {
    app.use('/api/_test', testRouter);
  }

  app.use((_req, res) => {
    sendRefusal(res, refusal('not_found', 'No such route.'));
  });

  app.use(errorHandler(logger));

  return app;
}
