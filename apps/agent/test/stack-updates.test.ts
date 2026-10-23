import { describe, expect, it } from 'vitest';
import { refusal, StackUpdateProgress, StackUpdateResult, type StackUpdateJob, type StackUpdateStep } from '@shipyard/schema';
import { AgentRequestError, type AgentClient } from '../src/client.js';
import { createStackUpdateRunner, reportInterruptedStackUpdates, stackUpdateProgressPath, stackUpdateResultPath } from '../src/stack-updates.js';

// SHP-REQ-197: the agent runs a stack update in the background, one at a time, posting each step
// as progress and the result until the server takes it.

const UPDATE_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_ID = '66666666-6666-4666-8666-666666666666';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

interface Call {
  path: string;
  body: unknown;
}

function fakeClient(handler: (call: Call, i: number) => unknown = () => ({ ok: true })): AgentClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    request(_method, path, body) {
      const call = { path, body };
      calls.push(call);
      try {
        return Promise.resolve(handler(call, calls.length - 1));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
  };
}

const job = (overrides: Partial<StackUpdateJob> = {}): StackUpdateJob => ({ updateId: UPDATE_ID, kind: 'update', stack: 'media', digests: { web: DIGEST }, ...overrides }) as StackUpdateJob;

const SUCCEEDED: StackUpdateResult = { updateId: UPDATE_ID, state: 'succeeded', images: [{ service: 'web', tag: 'latest', digest: DIGEST }], previous: [] };

describe('stack update runner', () => {
  it('posts each step as progress, in order, then the result; the job sees the stack in flight', async () => {
    const client = fakeClient();
    const steps: StackUpdateStep[] = ['verifying', 'backing_up', 'pulling', 'swapping', 'checking', 'soaking'];
    const finished: string[] = [];
    let inFlight = false;
    const runner = createStackUpdateRunner({
      client,
      execute: (j, onStep) => {
        inFlight = runner.inFlightFor('media') && !runner.inFlightFor('other') && runner.busy();
        for (const step of steps) onStep(step);
        return Promise.resolve({ ...SUCCEEDED, updateId: j.updateId });
      },
      onFinished: (j) => finished.push(j.stack),
      log: quiet,
    });
    const result = await runner.run(job());
    expect(result).toEqual(SUCCEEDED);
    expect(inFlight).toBe(true);
    expect(runner.busy()).toBe(false);
    expect(finished).toEqual(['media']);
    expect(client.calls.map((c) => c.path)).toEqual([...steps.map(() => stackUpdateProgressPath(UPDATE_ID)), stackUpdateResultPath(UPDATE_ID)]);
    expect(client.calls.slice(0, -1).map((c) => StackUpdateProgress.parse(c.body).step)).toEqual(steps);
    expect(StackUpdateResult.parse(client.calls.at(-1)?.body)).toEqual(SUCCEEDED);
  });

  it('refuses a second job while one runs — conflict, never queued', async () => {
    const client = fakeClient();
    let finish = (): void => undefined;
    const runner = createStackUpdateRunner({
      client,
      execute: (j) =>
        new Promise((resolve) => {
          finish = () => { resolve({ ...SUCCEEDED, updateId: j.updateId }); };
        }),
      log: quiet,
    });
    const first = runner.run(job());
    const second = await runner.run(job({ updateId: OTHER_ID }));
    expect(second).toMatchObject({ updateId: OTHER_ID, state: 'refused', refusal: { code: 'conflict' } });
    expect(client.calls.map((c) => c.path)).toEqual([stackUpdateResultPath(OTHER_ID)]);
    finish();
    await expect(first).resolves.toMatchObject({ state: 'succeeded' });
  });

  it('an engine that throws is a failed result, still delivered', async () => {
    const client = fakeClient();
    const runner = createStackUpdateRunner({ client, execute: () => Promise.reject(new Error('boom')), log: quiet });
    await expect(runner.run(job())).resolves.toMatchObject({ state: 'failed', refusal: { code: 'step_failed', message: expect.stringContaining('boom') as unknown } });
    expect(client.calls.at(-1)?.path).toBe(stackUpdateResultPath(UPDATE_ID));
  });

  it('retries the result until the server takes it, drops it on a 4xx, and an unreachable server never holds the engine', async () => {
    const delays: number[] = [];
    const client = fakeClient((call, i) => {
      if (call.path.endsWith('/progress')) throw new Error('ECONNREFUSED');
      if (i < 4) throw new Error('ECONNREFUSED');
      return { ok: true };
    });
    const runner = createStackUpdateRunner({
      client,
      execute: (j, onStep) => {
        onStep('verifying');
        return Promise.resolve({ ...SUCCEEDED, updateId: j.updateId });
      },
      log: quiet,
      sleep: (ms) => (delays.push(ms), Promise.resolve()),
    });
    await expect(runner.run(job())).resolves.toMatchObject({ state: 'succeeded' });
    expect(delays.length).toBeGreaterThan(0);

    const refusing = fakeClient((call) => {
      if (call.path.endsWith('/result')) throw new AgentRequestError(409, refusal('conflict', 'already has a result'), 'POST', call.path);
      return { ok: true };
    });
    const r2 = createStackUpdateRunner({ client: refusing, execute: (j) => Promise.resolve({ ...SUCCEEDED, updateId: j.updateId }), log: quiet });
    await expect(r2.run(job())).resolves.toMatchObject({ state: 'succeeded' });
    expect(refusing.calls.filter((c) => c.path.endsWith('/result'))).toHaveLength(1);
  });
});

describe('reportInterruptedStackUpdates', () => {
  it('reports an interrupted update failed, and one the ledger shows finished as succeeded', async () => {
    const client = fakeClient();
    await reportInterruptedStackUpdates({
      client,
      recovered: [
        { updateId: UPDATE_ID, stack: 'media', lastStep: 'stack-update:check', restored: ['/srv/media/compose.yml'], succeeded: false },
        { updateId: OTHER_ID, stack: 'media', lastStep: undefined, restored: [], succeeded: true },
      ],
      succeeded: () => ({ images: [{ service: 'web', tag: 'latest', digest: DIGEST }], previous: [] }),
      log: quiet,
    });
    const bodies = client.calls.map((c) => StackUpdateResult.parse(c.body));
    expect(bodies[0]).toMatchObject({ updateId: UPDATE_ID, state: 'failed', refusal: { code: 'interrupted', message: expect.stringContaining('previous compose file was put back') as unknown } });
    expect(bodies[1]).toMatchObject({ updateId: OTHER_ID, state: 'succeeded', images: [{ digest: DIGEST }] });
  });

  it('says so when recovering failed (a compose up that exited non-zero)', async () => {
    const client = fakeClient();
    await reportInterruptedStackUpdates({
      client,
      recovered: [{ updateId: UPDATE_ID, stack: 'media', lastStep: 'stack-update:swap', restored: ['/srv/media/compose.yml'], succeeded: false, error: 'compose up exited 1 after the previous compose file was put back' }],
      log: quiet,
    });
    const body = StackUpdateResult.parse(client.calls[0]?.body);
    expect(body).toMatchObject({ state: 'failed', refusal: { code: 'interrupted', message: expect.stringContaining('Recovering it failed: compose up exited 1') as unknown } });
  });
});
