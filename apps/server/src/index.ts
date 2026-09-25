import { createApp } from './app.js';
import { OidcSettings } from './auth/index.js';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { Bus } from './events.js';
import { createLogger } from './logger.js';
import { startApprovalExpiry } from './approvals/index.js';
import { startOutbox } from './outbox/index.js';
import { startScheduler } from './schedules/runner.js';
import { startBackups } from './jobs/backup.js';
import { startHeartbeat } from './jobs/heartbeat.js';
import { createMailer } from './mail/index.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const db = createDb(config.DATABASE_URL);
// Sign in with D3 Auth from server.env, else from Settings (SHP-REQ-110). Never throws: an
// unreachable or misconfigured D3 Auth leaves password login working (SHP-REQ-001).
const oidcSettings = new OidcSettings({ db, logger, config });
await oidcSettings.load();
const bus = new Bus();
const app = createApp({ db, logger, config, oidcSettings, bus });
const outbox = startOutbox({ db, logger, config, bus });
// Unanswered approvals expire after an hour (SHP-REQ-061).
const approvalExpiry = startApprovalExpiry({ db, logger, config, bus });
// Due schedules fire with every gate re-run (SHP-REQ-080).
const scheduler = startScheduler({ db, logger, config, bus });
const mailer = createMailer(config, logger);
// Shipyard's own nightly dump and restore drill (SHP-D-035), and the stale-agent alert.
const backups = startBackups({ db, logger, config, bus }, mailer);
const heartbeat = startHeartbeat({ db, logger, config, bus }, mailer);

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'listening');
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    Promise.all([outbox.stop(), approvalExpiry.stop(), scheduler.stop(), backups.stop(), heartbeat.stop()])
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
