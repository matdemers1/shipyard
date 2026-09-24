import { createApp } from './app.js';
import { createOidcClient } from './auth/index.js';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const db = createDb(config.DATABASE_URL);
// Never throws: an unreachable D3 Auth leaves password login working (SHP-REQ-001).
const oidc = await createOidcClient(config, logger);
const app = createApp({ db, logger, config, oidc });

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'listening');
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    db.$disconnect()
      .catch((err: unknown) => {
        logger.error({ err }, 'error disconnecting db');
      })
      .finally(() => {
        process.exit(0);
      });
  });
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
