import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, deployLogger } from '../../src/logger.js';

function capture(): { stream: Writable; lines: () => unknown[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as unknown),
  };
}

describe('createLogger', () => {
  it('logs JSON with the service base field', () => {
    const { stream, lines } = capture();
    const logger = createLogger('info', stream);
    logger.info('hello');
    const [line] = lines() as [{ service: string; msg: string }];
    expect(line.service).toBe('shipyard-server');
    expect(line.msg).toBe('hello');
  });

  it('redacts sensitive fields', () => {
    const { stream, lines } = capture();
    const logger = createLogger('info', stream);
    logger.info({ req: { headers: { authorization: 'Bearer secret', cookie: 'sid=1' } } }, 'request');
    const [line] = lines() as [{ req: { headers: { authorization: string; cookie: string } } }];
    expect(line.req.headers.authorization).toBe('[redacted]');
    expect(line.req.headers.cookie).toBe('[redacted]');
  });

  it('redacts password and token fields nested under any key', () => {
    const { stream, lines } = capture();
    const logger = createLogger('info', stream);
    logger.info({ user: { password: 'hunter2' }, auth: { token: 'abc' } }, 'creds');
    const [line] = lines() as [{ user: { password: string }; auth: { token: string } }];
    expect(line.user.password).toBe('[redacted]');
    expect(line.auth.token).toBe('[redacted]');
  });
});

describe('deployLogger', () => {
  it('stamps every line with deployId', () => {
    const { stream, lines } = capture();
    const logger = createLogger('info', stream);
    const withDeploy = deployLogger(logger, 'deploy-123');
    withDeploy.info('starting');
    const [line] = lines() as [{ deployId: string }];
    expect(line.deployId).toBe('deploy-123');
  });
});
