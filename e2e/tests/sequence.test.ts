import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Ledger, LABEL_MIGRATION, LABEL_SCHEMA, type SequencePorts } from '@shipyard/sequence';

// `machine.js` is not re-exported from the package index until the lead merges SHP-T-1.8.
import { runDeploy, type MachineContext } from '../../packages/sequence/src/machine.js';
import type { DeployRequest, DeployResult } from '../../packages/sequence/src/types.js';
import { enginePorts, linearMainState, memoryLog, openContext, prepareToyDataRoot, readText, type ToyDataRoot } from '../harness/engine.js';
import { MANIFEST_REGISTRY, randomRevision, startHarness, type Harness, type ToyImage } from '../harness/harness.js';

/**
 * SHP-T-1.8's doneWhen against the real world: dind, registry:2 and the fake GitHub, driven by the
 * real adapters from this process. One linear `main` history, deployed forward in order, so each
 * case starts from the release the previous one left live. Two more stacks, each in its own data
 * root and compose project, cover a wrong digest on a first deploy and a crash during soak.
 */

const REPO = `${MANIFEST_REGISTRY}/toy/app`;

describe('deploy state machine against the dind harness', () => {
  let h: Harness | undefined;
  let paths: ToyDataRoot | undefined;
  let ports: SequencePorts;
  const logLines: string[] = [];

  // c1..c7 on main, oldest first.
  const shas = Array.from({ length: 7 }, () => randomRevision());
  const [c1, c2, c3, c4, c5, c6, c7] = shas as [string, string, string, string, string, string, string];
  /** Extra stacks, torn down after the run. */
  const extraRoots: ToyDataRoot[] = [];
  const built = new Map<string, ToyImage>();

  beforeAll(async () => {
    h = await startHarness();
    paths = await prepareToyDataRoot({ soakSeconds: 3 });
    ports = enginePorts({ dockerHost: h.dockerHost, fakeGithubUrl: h.fakeGithubUrl, registryHostPort: h.registryHostPort }, memoryLog(logLines));
    await h.setGithubState(linearMainState(shas));

    const builds: [string, Parameters<Harness['buildToyImage']>[0]][] = [
      [c1, { mode: 'pass', schema: 's1', revision: c1 }],
      [c2, { mode: 'pass', schema: 's2', revision: c2 }],
      [c3, { mode: 'fail-health', schema: 's3', revision: c3 }],
      [c4, { mode: 'wrong-schema', schema: 's4', revision: c4 }],
      // Tagged sha-c5, but it claims (label and env) to be some other commit.
      [c5, { mode: 'pass', schema: 's5', revision: c5, labelRevision: randomRevision() }],
      [c6, { mode: 'fail-health', schema: 's6', revision: c6, contract: true }],
      // Healthy, then exits 1 a few seconds after every start; with a restart policy Docker brings
      // it straight back, so /health answers ok again by the next tick.
      [c7, { mode: 'exit-mid', schema: 's7', revision: c7 }],
    ];
    for (const [sha, opts] of builds) built.set(sha, await h.buildToyImage(opts));
  });

  afterAll(async () => {
    for (const root of [...(paths === undefined ? [] : [paths]), ...extraRoots]) {
      if (h !== undefined) await h.dind(['compose', '-f', root.composePath, '-p', root.project, 'down', '--timeout', '2']).catch(() => undefined);
      await root.remove();
    }
    await h?.stop();
  });

  const dataRoot = (): ToyDataRoot => {
    if (paths === undefined) throw new Error('data root not prepared');
    return paths;
  };
  const digest = (sha: string): string => {
    const image = built.get(sha);
    if (image === undefined) throw new Error(`no image for ${sha}`);
    return image.digest;
  };
  const reference = (sha: string): string => `${REPO}:sha-${sha}@${digest(sha)}`;

  let ctx: MachineContext;
  const deploy = async (sha: string, dryRun = false, root: ToyDataRoot = dataRoot()): Promise<DeployResult> => {
    ctx = await openContext(ports, root);
    const request: DeployRequest = {
      deployId: `dep-${sha.slice(0, 8)}-${Date.now().toString(36)}`,
      kind: 'deploy',
      app: 'toy',
      sha,
      dryRun,
      requesterLabel: 'e2e',
    };
    const result = await runDeploy(ports, ctx, request);
    if (process.env.SHIPYARD_E2E_VERBOSE === '1') console.log(logLines.join('\n'));
    return result;
  };

  const target = (root: ToyDataRoot = dataRoot()) => ({ files: [root.composePath], project: root.project });

  /** The running app container's digest and revision label, and what /health says now. */
  const observe = async (): Promise<{ digests: string[]; revision: string | undefined; health: { httpStatus: number; body: unknown } }> => {
    const containers = (await ports.docker.containers(target(), 'app')).filter((c) => c.state === 'running');
    expect(containers).toHaveLength(1);
    const health = await ports.docker.probeHealth(target(), 'app', 3000, '/health', 5_000);
    return { digests: containers[0]?.repoDigests ?? [], revision: containers[0]?.labels['org.opencontainers.image.revision'], health };
  };

  it('healthy: a first deploy, then a second SHA ahead of it, both succeed', async () => {
    const first = await deploy(c1);
    expect(first.refusal, JSON.stringify(first.refusal)).toBeNull();
    expect(first.state).toBe('succeeded');
    expect(first.schemaRevision).toBe('s1');
    expect(first.steps.map((s) => s.name)).toEqual(['verify', 'migrate', 'pull', 'swap', 'check', 'soak']);

    const second = await deploy(c2);
    expect(second.refusal, JSON.stringify(second.refusal)).toBeNull();
    expect(second.state).toBe('succeeded');
    expect(second.schemaRevision).toBe('s2');
    expect(second.gates.find((g) => g.gate === 'G7')?.reason).toContain('ahead of live');

    const ledger = await Ledger.open(ports.fs, dataRoot().ledgerPath);
    expect(ledger.entries('toy').map((e) => [e.sha, e.images[0]?.digest])).toEqual([
      [c1, digest(c1)],
      [c2, digest(c2)],
    ]);

    const compose = await readText(dataRoot().composePath);
    expect(compose).toContain(`image: ${reference(c2)}`);
    expect(compose).toMatch(/@sha256:[0-9a-f]{64}/);

    const now = await observe();
    expect(now.digests).toContain(`${REPO}@${digest(c2)}`);
    expect(now.revision).toBe(c2);
    expect(now.health).toEqual({ httpStatus: 200, body: { status: 'ok', schemaRevision: 's2' } });

    // The journal brackets each deploy and closes it with its terminal state.
    const ends = (await ctx.journal.readAll()).filter((e) => e.step === 'deploy' && e.phase === 'end').map((e) => e.detail?.['state']);
    expect(ends).toEqual(['succeeded', 'succeeded']);
  });

  it('a dry run evaluates the gates and changes nothing', async () => {
    const before = await readText(dataRoot().composePath);
    const journalBefore = await readText(dataRoot().journalPath);
    const result = await deploy(c3, true);
    expect(result.state).toBe('verifying');
    expect(result.gates.every((g) => g.pass)).toBe(true);
    expect(result.images[0]?.digest).toBe(digest(c3));
    expect(await readText(dataRoot().composePath)).toBe(before);
    expect(await readText(dataRoot().journalPath)).toBe(journalBefore);
  });

  it('unhealthy: fail-health rolls back and the previous release serves again', async () => {
    const before = await readText(dataRoot().composePath);
    const result = await deploy(c3);
    expect(result.state).toBe('rolled_back');
    expect(result.refusal?.code).toBe('health_failed');
    expect(await readText(dataRoot().composePath)).toBe(before);

    const now = await observe();
    expect(now.digests).toContain(`${REPO}@${digest(c2)}`);
    expect(now.health).toEqual({ httpStatus: 200, body: { status: 'ok', schemaRevision: 's2' } });
    const ledger = await Ledger.open(ports.fs, dataRoot().ledgerPath);
    expect(ledger.last('toy')?.sha).toBe(c2);
  });

  it('wrong schema: /health disagrees with the schema label → rolled_back (schema_mismatch)', async () => {
    expect(built.get(c4)).toBeDefined();
    const result = await deploy(c4);
    expect(result.images[0]?.labels[LABEL_SCHEMA]).toBe('s4');
    expect(result.state).toBe('rolled_back');
    expect(result.refusal?.code).toBe('schema_mismatch');
    expect(result.refusal?.message).toContain('s4-wrong');
    expect((await observe()).digests).toContain(`${REPO}@${digest(c2)}`);
  });

  it('wrong revision: an image tagged sha-<c5> that claims another commit → rolled_back (revision_mismatch)', async () => {
    const result = await deploy(c5);
    expect(result.state).toBe('rolled_back');
    expect(result.refusal?.code).toBe('revision_mismatch');
    expect(result.refusal?.message).toContain(c5);
    const now = await observe();
    expect(now.digests).toContain(`${REPO}@${digest(c2)}`);
    expect(now.revision).toBe(c2);
  });

  it('an older SHA than live is refused (not_ahead_of_live) and nothing moves', async () => {
    const before = await readText(dataRoot().composePath);
    const result = await deploy(c1);
    expect(result.state).toBe('refused');
    expect(result.refusal?.code).toBe('not_ahead_of_live');
    expect(result.steps.map((s) => s.name)).toEqual(['verify']);
    expect(await readText(dataRoot().composePath)).toBe(before);
  });

  it('contract: a contract-labelled release that fails health stops failed, not rolled back, on the new image', async () => {
    const result = await deploy(c6);
    expect(result.images[0]?.labels[LABEL_MIGRATION]).toBe('contract');
    expect(result.state).toBe('failed');
    expect(result.refusal?.code).toBe('health_failed');
    expect(result.refusal?.message).toContain('not rolled back');
    expect(result.steps.map((s) => s.name)).not.toContain('rollback');

    expect(await readText(dataRoot().composePath)).toContain(`image: ${reference(c6)}`);
    const containers = (await ports.docker.containers(target(), 'app')).filter((c) => c.state === 'running');
    expect(containers[0]?.repoDigests).toContain(`${REPO}@${digest(c6)}`);
    const ledger = await Ledger.open(ports.fs, dataRoot().ledgerPath);
    expect(ledger.last('toy')?.sha).toBe(c2);
  });

  it('wrong digest: a hand-owned override pins another digest → digest_mismatch; a first deploy leaves nothing running', async () => {
    // A second compose file pins app to c1's digest through a YAML merge key: the rewriter (which
    // only edits literal `image:` lines) cannot see it, compose honours it. So `up` runs a real
    // image that is not the verified one.
    const pin = [
      'x-pin: &pin',
      `  image: ${reference(c1)}`,
      'services:',
      '  app:',
      '    <<: *pin',
      '',
    ].join('\n');
    const root = await prepareToyDataRoot({ soakSeconds: 3, extraComposeFiles: { 'pin.yml': pin } });
    extraRoots.push(root);
    const before = await readText(root.composePath);

    const result = await deploy(c2, false, root);

    expect(result.refusal?.code).toBe('digest_mismatch');
    expect(result.refusal?.message).toContain(`${REPO}@${digest(c1)}`);
    expect(result.refusal?.message).toContain(`not the verified ${REPO}@${digest(c2)}`);
    // No previous release: the compose file is restored and the service removed, not left running.
    expect(result.state).toBe('rolled_back');
    expect(result.refusal?.message).toContain('had no previous release, so it was stopped and removed');
    expect(result.steps.map((s) => s.name)).toEqual(['verify', 'migrate', 'pull', 'swap', 'check', 'rollback']);
    expect(await readText(root.composePath)).toBe(before);
    expect(await ports.docker.containers(target(root), 'app')).toEqual([]);
    const ledger = await Ledger.open(ports.fs, root.ledgerPath);
    expect(ledger.last('toy')).toBeNull();
  });

  it('restart during soak: a container that crashes and is restarted between ticks → rolled_back', async () => {
    const restart = [
      'services:',
      '  app:',
      '    restart: unless-stopped',
      '    environment:',
      '      TOY_EXIT_AFTER_MS: "4000"',
      '',
    ].join('\n');
    const root = await prepareToyDataRoot({ soakSeconds: 10, extraComposeFiles: { 'restart.yml': restart } });
    extraRoots.push(root);

    const first = await deploy(c1, false, root);
    expect(first.refusal, JSON.stringify(first.refusal)).toBeNull();
    expect(first.state).toBe('succeeded');

    const result = await deploy(c7, false, root);
    expect(result.state).toBe('rolled_back');
    expect(result.refusal?.code).toBe('health_failed');
    expect(result.refusal?.message).toMatch(/Service "app" restarted during soak: /);
    expect(result.steps.map((s) => s.name)).toEqual(['verify', 'migrate', 'pull', 'swap', 'check', 'soak', 'rollback']);

    // c1 serves again, on its own digest.
    const running = (await ports.docker.containers(target(root), 'app')).filter((c) => c.state === 'running');
    expect(running).toHaveLength(1);
    expect(running[0]?.repoDigests).toContain(`${REPO}@${digest(c1)}`);
    expect(running[0]?.labels['org.opencontainers.image.revision']).toBe(c1);
    expect((await Ledger.open(ports.fs, root.ledgerPath)).last('toy')?.sha).toBe(c1);
  });
});
