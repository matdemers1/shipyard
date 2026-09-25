import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentClient } from '../src/client.js';
import { CONFIRM_INSTRUCTION, ENROL_PATH, ensureEnrolled, waitForConfirmation, type EnrolLog } from '../src/enrol.js';
import { loadOrCreateIdentity, type AgentIdentity } from '../src/identity.js';

let root: string;
let identity: AgentIdentity;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'shipyard-enrol-'));
  identity = await loadOrCreateIdentity(root);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function fakeClient(answers: unknown[]): { client: AgentClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: AgentClient = {
    request(method, path, body) {
      calls.push({ method, path, body });
      const next = answers.length > 1 ? answers.shift() : answers[0];
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
  return { client, calls };
}

function recordingLog(): { log: EnrolLog; lines: { level: string; obj: object; msg: string }[] } {
  const lines: { level: string; obj: object; msg: string }[] = [];
  return {
    lines,
    log: {
      info: (obj, msg) => lines.push({ level: 'info', obj, msg }),
      warn: (obj, msg) => lines.push({ level: 'warn', obj, msg }),
    },
  };
}

describe('ensureEnrolled', () => {
  it('posts the public key and version, and logs the fingerprint prominently when unconfirmed', async () => {
    const { client, calls } = fakeClient([{ fingerprint: identity.fingerprint, confirmed: false }]);
    const { log, lines } = recordingLog();
    const result = await ensureEnrolled(client, identity, '0.1.0', log);

    expect(result).toEqual({ confirmed: false });
    expect(calls).toEqual([
      { method: 'POST', path: ENROL_PATH, body: { publicKey: identity.publicKeyB64, agentVersion: '0.1.0' } },
    ]);
    const warn = lines.find((l) => l.level === 'warn');
    expect(warn?.msg).toContain(CONFIRM_INSTRUCTION);
    expect(warn?.msg).toContain(identity.fingerprint);
    expect(warn?.obj).toEqual({ fingerprint: identity.fingerprint });
  });

  it('returns confirmed without the warning once confirmed', async () => {
    const { client } = fakeClient([{ fingerprint: identity.fingerprint, confirmed: true }]);
    const { log, lines } = recordingLog();
    expect(await ensureEnrolled(client, identity, '0.1.0', log)).toEqual({ confirmed: true });
    expect(lines.some((l) => l.level === 'warn')).toBe(false);
  });

  it('rejects a malformed answer or one for another fingerprint', async () => {
    const { log } = recordingLog();
    await expect(ensureEnrolled(fakeClient([{ ok: true }]).client, identity, '0.1.0', log)).rejects.toThrow(/unexpected/);
    await expect(
      ensureEnrolled(fakeClient([{ fingerprint: 'SHA256:other', confirmed: true }]).client, identity, '0.1.0', log),
    ).rejects.toThrow(/different fingerprint/);
  });

  it('propagates a refusal from the client', async () => {
    const { log } = recordingLog();
    await expect(ensureEnrolled(fakeClient([new Error('refused')]).client, identity, '0.1.0', log)).rejects.toThrow('refused');
  });
});

describe('waitForConfirmation', () => {
  it('retries with capped backoff, through failures, until confirmed', async () => {
    const unconfirmed = { fingerprint: identity.fingerprint, confirmed: false };
    const { client, calls } = fakeClient([
      unconfirmed,
      new Error('network down'),
      unconfirmed,
      unconfirmed,
      unconfirmed,
      { fingerprint: identity.fingerprint, confirmed: true },
    ]);
    const { log, lines } = recordingLog();
    const delays: number[] = [];
    await waitForConfirmation(client, identity, '0.1.0', log, {
      initialDelayMs: 1000,
      maxDelayMs: 4000,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    expect(calls).toHaveLength(6);
    expect(delays).toEqual([1000, 2000, 4000, 4000, 4000]);
    expect(lines.some((l) => l.msg.includes('retrying'))).toBe(true);
  });

  it('stops when aborted', async () => {
    const { client } = fakeClient([{ fingerprint: identity.fingerprint, confirmed: false }]);
    const { log } = recordingLog();
    const controller = new AbortController();
    await expect(
      waitForConfirmation(client, identity, '0.1.0', log, {
        sleep: () => {
          controller.abort();
          return Promise.resolve();
        },
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});
