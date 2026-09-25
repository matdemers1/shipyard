import { createApp } from './app.js';
import { createOidcClient } from './auth/index.js';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { Bus } from './events.js';
import { createLogger } from './logger.js';
import { startApprovalExpiry } from './approvals/index.js';
import { startOutbox } from './outbox/index.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const db = createDb(config.DATABASE_URL);
// Never throws: an unreachable D3 Auth leaves password login working (SHP-REQ-001).
const oidc = await createOidcClient(config, logger);
const bus = new Bus();
const app = createApp({ db, logger, config, oidc, bus });
const outbox = startOutbox({ db, logger, config, bus });
// Unanswered approvals expire after an hour (SHP-REQ-061).
const approvalExpiry = startApprovalExpiry({ db, logger, config, bus });

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'listening');
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    Promise.all([outbox.stop(), approvalExpiry.stop()])
      .then(() => db.$disconnect())
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
