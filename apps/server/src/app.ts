import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Express, type Router } from 'express';
import { refusal } from '@shipyard/schema';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { auditContext, type AuditContextOptions } from './audit.js';
import type { Db } from './db.js';
import { errorHandler, sendRefusal } from './errors.js';
import { authenticate, authRouter, type OidcClient } from './auth/index.js';
import { agentRouter } from './agent/index.js';
import { appsRouter } from './apps/index.js';
import { deploysRouter } from './deploys/index.js';
import { Bus } from './events.js';
import { mcpRouter } from './mcp/index.js';
import { openapiRouter } from './openapi.js';
import { tokensRouter } from './tokens/index.js';
import { approvalsRouter, pendingApprovalsRouter } from './approvals/index.js';
import { commitsRouter } from './apps/commits.js';
import { deployEventsRouter } from './deploys/events.js';
import { usersRouter } from './users/index.js';
import { healthRouter } from './routes/health.js';

export interface AppDeps {
  db: Db;
  logger: Logger;
  config: Config;
  onUnauditedMutation?: AuditContextOptions['onUnauditedMutation'];
  /** Sign in with D3 Auth, built at boot by `createOidcClient`; null or absent means password only. */
  oidc?: OidcClient | null;
  /** Long-poll wake-ups; one per process. Tests may pass their own to observe or trigger it. */
  bus?: Bus;
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
  const authDeps = { db, logger, config, oidc: deps.oidc ?? null };
  const serviceDeps = { db, logger, config, bus: deps.bus ?? new Bus() };

  const app = express();
  app.disable('x-powered-by');
  if (config.TRUST_PROXY_HOPS !== undefined) app.set('trust proxy', config.TRUST_PROXY_HOPS);
  app.use(
    express.json({
      limit: '256kb',
      // The agent signs the exact bytes it sent (SHP-D-064); verification needs them, not a re-encoding.
      verify: (req, _res, buf) => {
        (req as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );

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

  // Before every route, so `req.actor` is set by the time any handler (or `req.audit`) runs.
  app.use(authenticate(authDeps));

  app.use('/api', healthRouter(db, config.SHIPYARD_VERSION));

  // ── Registration section ──────────────────────────────────────────────
  // Feature routers mount here, before the 404 handler below.
  app.use('/api/auth', authRouter(authDeps));
  app.use('/api', openapiRouter());
  app.use('/api/agent', agentRouter(serviceDeps));
  app.use('/api/apps', commitsRouter(serviceDeps));
  app.use('/api/apps', appsRouter(serviceDeps));
  app.use('/api/deploys', deployEventsRouter(serviceDeps));
  app.use('/api/deploys', approvalsRouter(serviceDeps));
  app.use('/api/deploys', deploysRouter(serviceDeps));
  app.use('/api', usersRouter(serviceDeps));
  app.use('/api', pendingApprovalsRouter(serviceDeps));
  app.use('/api/tokens', tokensRouter(serviceDeps));
  app.use('/mcp', mcpRouter(serviceDeps));

  // The console is served by the server itself: one origin, one cookie, no CORS. In development
  // Vite serves it and CONSOLE_DIST is unset. The SPA fallback never answers /api or /mcp: a
  // mistyped endpoint must 404 as JSON, not return HTML.
  const consoleDist = config.CONSOLE_DIST;
  if (consoleDist !== undefined && existsSync(consoleDist)) {
    app.use(express.static(consoleDist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/(?:api|mcp)(?:\/|$)).*/, (_req, res) => {
      res.sendFile(join(consoleDist, 'index.html'));
    });
  }
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
