import { describe, expect, it } from 'vitest';
import { MaintenanceProgress, MaintenanceResult, refusal, type MaintenanceJob, type MaintenanceStep } from '@shipyard/schema';
import type { MaintenanceRecovery } from '@shipyard/sequence';
import { AgentRequestError, type AgentClient } from '../src/client.js';
import { createMaintenanceRunner, maintenanceProgressPath, maintenanceResultPath, reportInterruptedMaintenance } from '../src/maintenance.js';

// SHP-ADR-012, SHP-T-17.2: the agent runs a volume or prune job in the background, one at a time,
// posting each step as progress and the result until the server takes it; after a restart it
// reports an interrupted job failed and closes it.

const JOB_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_ID = '66666666-6666-4666-8666-666666666666';
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

const job = (jobId = JOB_ID): MaintenanceJob => ({ jobId, kind: 'volume-backup', volume: 'media_config', owner: { kind: 'stack', name: 'media' }, quiesce: true });

describe('maintenance runner', () => {
  it('posts each step as progress, in order, then the result', async () => {
    const client = fakeClient();
    const steps: MaintenanceStep[] = ['checking', 'stopping', 'archiving', 'starting', 'retaining'];
    const finished: string[] = [];
    const runner = createMaintenanceRunner({
      client,
      execute: (j, onStep) => {
        expect(runner.busy()).toBe(true);
        for (const step of steps) onStep(step);
        return Promise.resolve({ jobId: j.jobId, state: 'succeeded', removedArchives: [] });
      },
      onFinished: (j) => finished.push(j.jobId),
      log: quiet,
    });
    const result = await runner.run(job());
    expect(result).toEqual({ jobId: JOB_ID, state: 'succeeded', removedArchives: [] });
    expect(runner.busy()).toBe(false);
    expect(finished).toEqual([JOB_ID]);
    expect(client.calls.map((c) => c.path)).toEqual([...steps.map(() => maintenanceProgressPath(JOB_ID)), maintenanceResultPath(JOB_ID)]);
    expect(client.calls.slice(0, -1).map((c) => MaintenanceProgress.parse(c.body).step)).toEqual(steps);
    expect(MaintenanceResult.parse(client.calls.at(-1)?.body)).toEqual(result);
  });

  it('refuses a second job while one runs — conflict, never queued', async () => {
    const client = fakeClient();
    let finish = (): void => undefined;
    const runner = createMaintenanceRunner({
      client,
      execute: (j) =>
        new Promise((resolve) => {
          finish = () => {
            resolve({ jobId: j.jobId, state: 'succeeded' });
          };
        }),
      log: quiet,
    });
    const first = runner.run(job());
    const second = await runner.run(job(OTHER_ID));
    expect(second).toMatchObject({ jobId: OTHER_ID, state: 'refused', refusal: { code: 'conflict' } });
    expect(client.calls.map((c) => c.path)).toEqual([maintenanceResultPath(OTHER_ID)]);
    finish();
    await first;
  });

  it('retries an undelivered result with backoff; drops one the server refuses', async () => {
    const delays: number[] = [];
    let fails = 2;
    const client = fakeClient((call) => {
      if (call.path.endsWith('/result') && fails-- > 0) throw new Error('ECONNREFUSED');
      return { ok: true };
    });
    const runner = createMaintenanceRunner({
      client,
      execute: (j) => Promise.resolve({ jobId: j.jobId, state: 'succeeded' }),
      log: quiet,
      sleep: (ms) => (delays.push(ms), Promise.resolve()),
      backoff: { initialMs: 10, maxMs: 15 },
    });
    await runner.run(job());
    expect(delays).toEqual([10, 15]);
    expect(client.calls.filter((c) => c.path === maintenanceResultPath(JOB_ID))).toHaveLength(3);

    const refusing = fakeClient(() => {
      throw new AgentRequestError(409, refusal('conflict', 'already has a result'), 'POST', 'x');
    });
    const r2 = createMaintenanceRunner({ client: refusing, execute: (j) => Promise.resolve({ jobId: j.jobId, state: 'succeeded' }), log: quiet, sleep: () => Promise.resolve() });
    await r2.run(job());
    expect(refusing.calls).toHaveLength(1);
  });

  it('a throwing engine is reported failed, without a host path', async () => {
    const client = fakeClient();
    const runner = createMaintenanceRunner({ client, execute: () => Promise.reject(new Error("boom at '/DATA/AppData/shipyard/agent'")), log: quiet });
    const result = await runner.run(job());
    expect(result).toMatchObject({ state: 'failed', refusal: { code: 'step_failed' } });
    expect(result.refusal?.message).not.toContain('/');
  });
});

describe('reportInterruptedMaintenance', () => {
  const recovery = (o: Partial<MaintenanceRecovery> = {}): MaintenanceRecovery => ({
    jobId: JOB_ID,
    kind: 'volume-restore',
    name: 'media',
    lastStep: 'maintenance:volume-restore:extract',
    report: true,
    restarted: true,
    startExitCode: 0,
    archives: ['77777777-7777-4777-8777-777777777777'],
    restoredFromSafety: false,
    leftStopped: false,
    safetyArchiveId: '77777777-7777-4777-8777-777777777777',
    ...o,
  });

  it('reports failed/interrupted, saying the stack was started again and naming the safety archive, then closes it', async () => {
    const client = fakeClient();
    const closed: string[] = [];
    await reportInterruptedMaintenance({ client, recovered: [recovery()], close: (r) => (closed.push(r.jobId), Promise.resolve()), log: quiet });
    const body = MaintenanceResult.parse(client.calls[0]?.body);
    expect(client.calls[0]?.path).toBe(maintenanceResultPath(JOB_ID));
    expect(body).toMatchObject({ jobId: JOB_ID, state: 'failed', refusal: { code: 'interrupted' } });
    expect(body.refusal?.message).toContain('started again');
    expect(body.refusal?.message).toContain('77777777-7777-4777-8777-777777777777');
    expect(closed).toEqual([JOB_ID]);
  });

  it('says when a half-restored volume was put back from its safety archive, or its stack left stopped', async () => {
    const client = fakeClient();
    await reportInterruptedMaintenance({
      client,
      recovered: [recovery({ restoredFromSafety: true }), recovery({ jobId: OTHER_ID, leftStopped: true, restarted: false, startExitCode: null })],
      close: () => Promise.resolve(),
      log: quiet,
    });
    const [back, stopped] = client.calls.map((c) => MaintenanceResult.parse(c.body));
    expect(back?.refusal?.message).toContain('put back from safety archive 77777777-7777-4777-8777-777777777777');
    expect(stopped?.refusal?.message).toContain('left stopped');
    expect(stopped?.refusal?.message).not.toContain('started again');
    expect(stopped?.refusal?.fix).toContain('77777777-7777-4777-8777-777777777777');
  });

  it('keeps one it cannot report for the next start; only closes one the server does not know', async () => {
    const down = fakeClient(() => {
      throw new Error('ECONNREFUSED');
    });
    const closed: string[] = [];
    const close = (r: MaintenanceRecovery): Promise<void> => (closed.push(r.jobId), Promise.resolve());
    await reportInterruptedMaintenance({ client: down, recovered: [recovery()], close, log: quiet });
    expect(closed).toEqual([]);
    const client = fakeClient();
    await reportInterruptedMaintenance({ client, recovered: [recovery({ report: false })], close, log: quiet });
    expect(client.calls).toEqual([]);
    expect(closed).toEqual([JOB_ID]);
  });
});
