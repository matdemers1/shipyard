import pino, { type Logger } from 'pino';

/**
 * Structured JSON logging to stdout (SHP-REQ-007). Every line carries `service`; deploy-related
 * lines additionally carry `deployId` via {@link deployLogger}.
 */
export function createLogger(level: string, destination?: pino.DestinationStream): Logger {
  const base = {
    level,
    base: { service: 'shipyard-server' },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.password',
        '*.totp',
        '*.totpSecret',
        '*.totpCode',
        '*.token',
      ],
      censor: '[redacted]',
    },
  };
  return destination === undefined ? pino(base) : pino(base, destination);
}

/** A child logger that stamps every line with the deploy ID (SHP-REQ-007). */
export function deployLogger(logger: Logger, deployId: string): Logger {
  return logger.child({ deployId });
}
