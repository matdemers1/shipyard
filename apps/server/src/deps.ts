import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { Db } from './db.js';
import type { Bus } from './events.js';

/** What every feature router and background job is built from. */
export interface ServiceDeps {
  db: Db;
  logger: Logger;
  config: Config;
  bus: Bus;
}
