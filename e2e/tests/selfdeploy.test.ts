import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseManifestYaml, type TargetResult } from '@shipyard/schema';
import { Ledger, type SequencePorts } from '@shipyard/sequence';

import { createAgentClient } from '../../apps/agent/src/client.js';
import { loadOrCreateIdentity } from '../../apps/agent/src/identity.js';
import {
  createTargetRunner,
  fileTargetStore,
  runLoop,
  targetStorePath,
  type LoopLog,
  type TargetRecord,
} from '../../apps/agent/src/loop.js';
// `machine.js` and `rollback.js` are imported by path until the lead exports them from the index.
import { runDeploy } from '../../packages/sequence/src/machine.js';
import { runRollback } from '../../packages/sequence/src/rollback.js';
import { startFakeControlPlane, type FakeControlPlane } from '../harness/control-plane.js';
import { E2E_TIMINGS, enginePorts, linearMainState, memoryLog, openContext, prepareToyDataRoot, readText, type ToyDataRoot } from '../harness/engine.js';
import { MANIFEST_REGISTRY, randomRevision, startHarness, type Harness, type ToyImage } from '../harness/harness.js';

/**
 * SHP-T-4.8 (SHP-REQ-071, SHP-REQ-072, SHP-D-011, SHP-D-081): Shipyard deploys its own server as
 * an ordinary manifest, and a broken server release is rolled back by the agent alone.
 *
 * The real agent loop (`runLoop` + `createTargetRunner`, the real signed client and identity, the
 * real engine) runs against a fake control plane. The app it deploys is named `shipyard` with a
 * `server` service, played by the toy app. The new release fails its health check, and the moment
 * the agent reports `swapping` the control plane goes away, as a broken self-deployed server
 * would. The agent must check, fail health, roll back on its own, keep the result, and deliver it
 * once a server answers again.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const REPO = `${MANIFEST_REGISTRY}/toy/app`;

async function waitFor(what: string, cond: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('docs/manifests/shipyard.yml', () => {
  it('is a valid manifest for the server only, never the agent (SHP-D-011)', async () => {
    const manifest = parseManifestYaml(await readFile(resolve(REPO_ROOT, 'docs/manifests/shipyard.yml'), 'utf8'));
    expect(manifest).toMatchObject({
      name: 'shipyard',
      repo: 'matdemers1/shipyard',
      workflow: 'ci.yml',
      compose: { files: ['/DATA/shipyard/docker-compose.yml'], project: 'shipyard' },
      services: { server: { image: 'ghcr.io/matdemers1/shipyard/server' } },
      health: { service: 'server', port: 3300, path: '/api/health' },
      soakSeconds: 120,
      steps: { migrate: { service: 'server', argv: ['node', 'node_modules/prisma/build/index.js', 'migrate', 'deploy'] } },
      envFiles: ['/DATA/shipyard/server.env'],
      foreman: { project: 'SHP', environment: 'production' },
    });
    expect(Object.keys(manifest.services)).toEqual(['server']);
  });
});

describe('self-deploy: a broken server release rolls back with the server unreachable', () => {
  let h: Harness | undefined;
  let paths: ToyDataRoot | undefined;
  let plane: FakeControlPlane | undefined;
  let ports: SequencePorts;
  const engineLog: string[] = [];
  const agentLog: string[] = [];
  const stopping = new AbortController();
  let loop: Promise<void> | undefined;
  const [c1, c2] = [randomRevision(), randomRevision()];
  const built = new Map<string, ToyImage>();

  beforeAll(async () => {
    h = await startHarness();
    paths = await prepareToyDataRoot({ app: 'shipyard', service: 'server', soakSeconds: 2 });
    ports = enginePorts({ dockerHost: h.dockerHost, fakeGithubUrl: h.fakeGithubUrl, registryHostPort: h.registryHostPort }, memoryLog(engineLog));
    await h.setGithubState(linearMainState([c1, c2]));
    built.set(c1, await h.buildToyImage({ mode: 'pass', schema: 's1', revision: c1 }));
    built.set(c2, await h.buildToyImage({ mode: 'fail-health', schema: 's2', revision: c2 }));
    plane = await startFakeControlPlane();
  });

  afterAll(async () => {
    stopping.abort();
    await plane?.stop();
    await loop?.catch(() => undefined);
    if (h !== undefined && paths !== undefined) {
      await h.dind(['compose', '-f', paths.composePath, '-p', paths.project, 'down', '--timeout', '2']).catch(() => undefined);
    }
    if (process.env.SHIPYARD_E2E_VERBOSE === '1') console.log([...agentLog, ...engineLog].join('\n'));
    await paths?.remove();
    await h?.stop();
  });

  const dataRoot = (): ToyDataRoot => {
    if (paths === undefined) throw new Error('data root not prepared');
    return paths;
  };
  const digest = (sha: string): string => built.get(sha)?.digest ?? '';

  it('the agent swaps, fails health, rolls back alone, keeps the result, and delivers it when the server returns', async () => {
    if (h === undefined || plane === undefined) throw new Error('harness did not start');
    const fake = plane;
    const p = dataRoot();

    // The running, verified-good server release.
    const first = await runDeploy(ports, await openContext(ports, p), {
      deployId: 'dep-server-good',
      kind: 'deploy',
      app: 'shipyard',
      sha: c1,
      dryRun: false,
      requesterLabel: 'e2e',
    });
    expect(first.refusal, JSON.stringify(first.refusal)).toBeNull();
    expect(first.state).toBe('succeeded');
    const goodCompose = await readText(p.composePath);
    expect(goodCompose).toContain(`${REPO}:sha-${c1}@${digest(c1)}`);

    // The real agent, wired the way apps/agent/src/index.ts wires it.
    const log: LoopLog = {
      info: (o, m) => agentLog.push(`info ${m ?? ''} ${JSON.stringify(o)}`),
      warn: (o, m) => agentLog.push(`warn ${m ?? ''} ${JSON.stringify(o)}`),
      error: (o, m) => agentLog.push(`error ${m ?? ''} ${JSON.stringify(o)}`),
    };
    const identity = await loadOrCreateIdentity(p.dataRoot);
    const client = createAgentClient({ serverUrl: fake.url, identity, timeoutMs: 5_000 });
    const store = fileTargetStore(ports.fs, targetStorePath(p.dataRoot));
    const backoff = { initialMs: 200, maxMs: 1_000 };
    const runTarget = createTargetRunner({
      client,
      engine: {
        deploy: (ctx, request) => runDeploy(ports, ctx, request),
        rollback: (ctx, request) => runRollback(ports, ctx, request),
      },
      context: () => openContext(ports, p, { ...E2E_TIMINGS, healthTimeoutMs: 8_000 }),
      store,
      log,
      signal: stopping.signal,
      backoff,
    });

    // The server goes away the moment the agent says it is swapping the server's image.
    let downAt = 0;
    fake.onProgress = (body) => {
      if (body['state'] === 'swapping' && downAt === 0) {
        downAt = Date.now();
        void fake.down();
      }
    };
    fake.enqueue({ targetId: 'tgt-self', deployId: 'dep-server-broken', kind: 'deploy', app: 'shipyard', sha: c2, dryRun: false, requesterLabel: 'e2e' });
    loop = runLoop({ client, runTarget, log, signal: stopping.signal, backoff });

    // With nobody to talk to, the engine still finishes: health fails and it rolls back.
    const finished = (): boolean => agentLog.some((l) => l.includes('target finished'));
    await waitFor('the engine to finish with the server down', finished, 180_000);
    expect(downAt).toBeGreaterThan(0);
    expect(fake.up).toBe(false);
    expect(agentLog.find((l) => l.includes('target finished'))).toContain('"state":"rolled_back"');
    expect(agentLog.some((l) => l.includes('server unreachable mid-deploy'))).toBe(true);
    // Nothing reached the server after it went down, and no result has been delivered.
    expect(fake.received.filter((r) => r.at > downAt)).toEqual([]);
    expect(fake.received.some((r) => r.path === '/api/agent/result')).toBe(false);

    // The previous server release is back, byte for byte, and healthy.
    expect(await readText(p.composePath)).toBe(goodCompose);
    const target = { files: [p.composePath], project: p.project };
    const running = (await ports.docker.containers(target, 'server')).filter((c) => c.state === 'running');
    expect(running).toHaveLength(1);
    expect(running[0]?.repoDigests).toContain(`${REPO}@${digest(c1)}`);
    expect(running[0]?.labels['org.opencontainers.image.revision']).toBe(c1);
    expect(await ports.docker.probeHealth(target, 'server', 3000, '/health', 3_000)).toEqual({
      httpStatus: 200,
      body: { status: 'ok', schemaRevision: 's1' },
    });
    const ledger = await Ledger.open(ports.fs, p.ledgerPath);
    expect(ledger.last('shipyard')?.sha).toBe(c1);

    // The result is kept locally until the server takes it.
    const kept = async (): Promise<TargetRecord | undefined> => (await store.all()).find((r) => r.targetId === 'tgt-self');
    await waitFor('the result to be kept in targets.json', async () => (await kept())?.result !== undefined, 10_000);
    expect((await kept())?.result).toMatchObject({ state: 'rolled_back', refusal: { code: 'health_failed' } });
    expect(agentLog.some((l) => l.includes('result not delivered; retrying'))).toBe(true);

    // A server answers again: the agent syncs the steps it journaled while alone, then the result.
    await fake.restart();
    await waitFor('the result to be delivered', () => fake.received.some((r) => r.path === '/api/agent/result'), 30_000);
    const results = fake.received.filter((r) => r.path === '/api/agent/result');
    expect(results).toHaveLength(1);
    const result = results[0]?.body as TargetResult;
    expect(result).toMatchObject({ targetId: 'tgt-self', state: 'rolled_back', refusal: { code: 'health_failed' } });
    const lateSteps = fake.received.filter((r) => r.path === '/api/agent/steps' && r.at > downAt).map((r) => (r.body as { name: string }).name);
    expect(lateSteps).toContain('check');
    expect(lateSteps).toContain('rollback');
    // Every journal line reached the server before the result did.
    const resultAt = results[0]?.at ?? 0;
    expect(fake.received.filter((r) => r.path === '/api/agent/steps' && r.at > resultAt)).toEqual([]);
    await waitFor('targets.json to be emptied', async () => (await kept()) === undefined, 5_000);
    expect(fake.keys).toEqual(new Set([identity.fingerprint]));

    // The agent is back to polling.
    await waitFor('the agent to poll again', () => fake.received.some((r) => r.path === '/api/agent/poll' && r.at > resultAt), 10_000);
    stopping.abort();
    await loop;
  });
});
