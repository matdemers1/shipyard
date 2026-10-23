import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ActionResult, LogsChunk } from '@shipyard/schema';
import { ACTION_STEP, Journal, loadManifests, loadStacks, runDeploy, type SequencePorts } from '@shipyard/sequence';

import { actionProgressPath, actionResultPath, createActionRunner } from '../../apps/agent/src/actions.js';
import { createAgentClient } from '../../apps/agent/src/client.js';
import { loadOrCreateIdentity } from '../../apps/agent/src/identity.js';
import { createLogsRunner, logsChunkPath } from '../../apps/agent/src/logs.js';
import { runLoop } from '../../apps/agent/src/loop.js';
import { startFakeControlPlane, type FakeControlPlane } from '../harness/control-plane.js';
import { enginePorts, linearMainState, memoryLog, openContext, prepareToyDataRoot, type ToyDataRoot } from '../harness/engine.js';
import { randomRevision, startHarness, type Harness } from '../harness/harness.js';

/**
 * SHP-T-15.3 (SHP-REQ-184, SHP-REQ-187, SHP-REQ-189, SHP-REQ-190): the real agent loop, against
 * the real dind daemon, takes a lifecycle action and a log read from the fake control plane. A
 * `restart` of the toy app's service is journaled, run through compose, and the service is running
 * again; a log read of its container (the `print-secret` toy prints TOY_SECRET on start) comes back
 * with the secret's value `[redacted]`, and the value appears nowhere the agent sent.
 *
 * The toy compose file gives the container `TOY_SECRET=not-a-real-secret` — 17 characters, so it is
 * redacted as an inspected Env value longer than eight.
 */

const TOY_SECRET_VALUE = 'not-a-real-secret';

async function waitFor(what: string, cond: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('lifecycle actions and logs through the agent loop', () => {
  let h: Harness | undefined;
  let paths: ToyDataRoot | undefined;
  let plane: FakeControlPlane | undefined;
  let ports: SequencePorts;
  const stop = new AbortController();
  let loop: Promise<void> | undefined;
  const logLines: string[] = [];
  const sha = randomRevision();

  beforeAll(async () => {
    h = await startHarness();
    paths = await prepareToyDataRoot({ soakSeconds: 2 });
    ports = enginePorts({ dockerHost: h.dockerHost, fakeGithubUrl: h.fakeGithubUrl, registryHostPort: h.registryHostPort }, memoryLog(logLines));
    await h.setGithubState(linearMainState([sha]));
    await h.buildToyImage({ mode: 'print-secret', schema: 's1', revision: sha });
    plane = await startFakeControlPlane();

    const deployed = await runDeploy(ports, await openContext(ports, paths), {
      deployId: 'dep-actions',
      kind: 'deploy',
      app: 'toy',
      sha,
      dryRun: false,
      requesterLabel: 'e2e',
    });
    expect(deployed.refusal, JSON.stringify(deployed.refusal)).toBeNull();

    // Wired the way apps/agent/src/index.ts wires it.
    const p = paths;
    const identity = await loadOrCreateIdentity(p.dataRoot);
    const client = createAgentClient({ serverUrl: plane.url, identity, timeoutMs: 35_000 });
    const log = memoryLog(logLines);
    const actions = createActionRunner({
      client,
      docker: ports.docker,
      fs: ports.fs,
      journal: new Journal(ports.fs, p.journalPath, ports.clock, log),
      clock: ports.clock,
      apps: () => loadManifests(ports.fs, p.dataRoot),
      stacks: () => loadStacks(ports.fs, p.dataRoot),
      deployInFlight: () => false,
      log,
      signal: stop.signal,
    });
    const logs = createLogsRunner({
      client,
      docker: ports.docker,
      fs: ports.fs,
      apps: () => loadManifests(ports.fs, p.dataRoot),
      stacks: () => loadStacks(ports.fs, p.dataRoot),
      log,
    });
    loop = runLoop({ client, runTarget: () => Promise.resolve(), actions, logs, log, signal: stop.signal });
  });

  afterAll(async () => {
    stop.abort();
    await plane?.stop();
    await loop?.catch(() => undefined);
    if (h !== undefined && paths !== undefined) {
      await h.dind(['compose', '-f', paths.composePath, '-p', paths.project, 'down', '--timeout', '2']).catch(() => undefined);
    }
    await paths?.remove();
    await h?.stop();
  });

  it("restarts the toy app's service: journaled first, run through compose, running again", async () => {
    if (plane === undefined || paths === undefined) throw new Error('harness did not start');
    const fake = plane;
    const target = { files: [paths.composePath], project: paths.project };
    const [before] = await ports.docker.containers(target, 'app');
    expect(before?.state).toBe('running');

    // The agent advertises both capabilities on every poll.
    await waitFor('a poll', () => fake.received.some((r) => r.path === '/api/agent/poll'), 30_000);
    expect(fake.received.find((r) => r.path === '/api/agent/poll')?.body).toMatchObject({ capabilities: ['actions', 'logs'] });

    const actionId = randomUUID();
    fake.enqueueAction({ actionId, target: { kind: 'app', name: 'toy' }, verb: 'restart', service: 'app', requesterLabel: 'e2e' });
    await waitFor('the action result', () => fake.received.some((r) => r.path === actionResultPath(actionId)), 120_000);

    const paths_ = fake.received.map((r) => r.path);
    expect(paths_.indexOf(actionProgressPath(actionId))).toBeLessThan(paths_.indexOf(actionResultPath(actionId)));
    const result = ActionResult.parse(fake.received.find((r) => r.path === actionResultPath(actionId))?.body);
    expect(result.state, JSON.stringify(result)).toBe('succeeded');

    const [after] = await ports.docker.containers(target, 'app');
    expect(after?.state).toBe('running');
    expect(after?.id).toBe(before?.id);
    expect(after?.startedAt).not.toBe(before?.startedAt);

    // Journaled before it ran, ended after (SHP-REQ-187).
    const journal = await new Journal(ports.fs, paths.journalPath, ports.clock, memoryLog()).readAll();
    expect(journal.filter((e) => e.deployId === actionId).map((e) => [e.step, e.phase])).toEqual([
      [ACTION_STEP, 'start'],
      [ACTION_STEP, 'end'],
    ]);
  });

  it("reads the service's logs with TOY_SECRET's value redacted on the agent", async () => {
    if (plane === undefined || paths === undefined) throw new Error('harness did not start');
    const fake = plane;
    const [container] = await ports.docker.containers({ files: [paths.composePath], project: paths.project }, 'app');
    if (container === undefined) throw new Error('no toy container');

    const logsId = randomUUID();
    fake.enqueueLogs({ logsId, containerId: container.id, tail: 200, follow: false, followSeconds: 0 });
    const chunks = (): LogsChunk[] => fake.received.filter((r) => r.path === logsChunkPath(logsId)).map((r) => LogsChunk.parse(r.body));
    await waitFor('the last log chunk', () => chunks().some((c) => c.done), 60_000);

    const all = chunks();
    expect(all.map((c) => c.seq)).toEqual(all.map((_, i) => i));
    expect(all.at(-1)?.error).toBeUndefined();
    const texts = all.flatMap((c) => c.lines.map((l) => l.text));
    // Printed once per start: the deploy's and the restart's.
    expect(texts.filter((t) => t.includes('toy: TOY_SECRET=[redacted]')).length).toBeGreaterThanOrEqual(2);
    expect(all.flatMap((c) => c.lines).every((l) => l.at !== null)).toBe(true);
    expect(JSON.stringify(fake.received)).not.toContain(TOY_SECRET_VALUE);
    // Nor in the agent's own log.
    expect(logLines.join('\n')).not.toContain(TOY_SECRET_VALUE);
  });

  it('follows the logs and stops at the followSeconds window', async () => {
    if (plane === undefined || paths === undefined) throw new Error('harness did not start');
    const fake = plane;
    const [container] = await ports.docker.containers({ files: [paths.composePath], project: paths.project }, 'app');
    if (container === undefined) throw new Error('no toy container');

    const logsId = randomUUID();
    const started = Date.now();
    fake.enqueueLogs({ logsId, containerId: container.id, tail: 5, follow: true, followSeconds: 3 });
    await waitFor('the followed read to end', () => fake.received.some((r) => r.path === logsChunkPath(logsId) && LogsChunk.parse(r.body).done), 30_000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(3_000);
    expect(JSON.stringify(fake.received)).not.toContain(TOY_SECRET_VALUE);
  });
});
