import type { Request, Response } from 'express';
import { refusal } from '@shipyard/schema';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { ZodError, z } from 'zod';
import { errorHandler, sendRefusal } from '../../src/errors.js';

interface FakeRes {
  headersSent: boolean;
  status: (code: number) => FakeRes;
  json: (body: unknown) => FakeRes;
}

function mockRes(): { res: FakeRes; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const status = vi.fn();
  const json = vi.fn();
  const res: FakeRes = {
    headersSent: false,
    status: (code: number) => {
      status(code);
      return res;
    },
    json: (body: unknown) => {
      json(body);
      return res;
    },
  };
  return { res, status, json };
}

const fakeReq = {} as Request;

describe('sendRefusal', () => {
  it('uses the catalogue http status for the code', () => {
    const { res, status, json } = mockRes();
    sendRefusal(res as unknown as Response, refusal('not_found', 'no such thing'));
    expect(status).toHaveBeenCalledWith(404);
    const body = json.mock.calls[0]?.[0] as { error: { code: string; message: string } };
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toBe('no such thing');
  });
});

describe('errorHandler', () => {
  const logger = pino({ enabled: false });

  it('turns a ZodError into invalid_request', () => {
    const { res, status, json } = mockRes();
    const handler = errorHandler(logger);
    let zodErr: ZodError | undefined;
    try {
      z.string().parse(123);
    } catch (e) {
      zodErr = e as ZodError;
    }
    if (zodErr === undefined) throw new Error('expected a ZodError');
    const next = vi.fn();
    handler(zodErr, fakeReq, res as unknown as Response, next);
    expect(status).toHaveBeenCalledWith(400);
    const body = json.mock.calls[0]?.[0] as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
    expect(next).not.toHaveBeenCalled();
  });

  it('turns any other error into a generic 500 that never leaks the stack', () => {
    const { res, status, json } = mockRes();
    const handler = errorHandler(logger);
    const next = vi.fn();
    handler(new Error('boom, sensitive stack info'), fakeReq, res as unknown as Response, next);
    expect(status).toHaveBeenCalledWith(500);
    const body = json.mock.calls[0]?.[0] as { error: { message: string } };
    expect(body.error.message).not.toContain('boom');
    expect(body.error.message).not.toContain('sensitive');
  });

  it('delegates to next when headers are already sent', () => {
    const { res, status } = mockRes();
    res.headersSent = true;
    const handler = errorHandler(logger);
    const next = vi.fn();
    const err = new Error('late');
    handler(err, fakeReq, res as unknown as Response, next);
    expect(next).toHaveBeenCalledWith(err);
    expect(status).not.toHaveBeenCalled();
  });
});
