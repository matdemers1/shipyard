import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDockerAdapter,
  createGitHubAdapter,
  createRegistryAdapter,
  Journal,
  Ledger,
  loadManifests,
  nodeFs,
  systemClock,
  type Log,
  type SequencePorts,
} from '@shipyard/sequence';
import { stringify } from 'yaml';

// `machine.js` is not re-exported from the package index until the lead merges SHP-T-1.8.
import type { MachineContext } from '../../packages/sequence/src/machine.js';
import { INTERNAL_REGISTRY, MANIFEST_REGISTRY, TOY_APP_DIR } from './harness.js';

/**
 * Drives the real deploy engine against the harness: real Docker (dind), real registry, fake
 * GitHub. Two harness facts are bridged here, never in the engine:
 *
 * - The manifest schema refuses an image repository with a port in it, so the engine's manifest
 *   names the registry `registry.shipyard.test` (the same storage as `registry:5000`, see
 *   compose.yml). The host cannot resolve that name; the registry adapter's fetch is pointed at the
 *   published loopback port instead.
 * - The fake GitHub serves `/actions/runs?head_sha=`, whereas the adapter asks for the
 *   workflow-scoped `/actions/workflows/<file>/runs?head_sha=`; the GitHub adapter's fetch maps one
 *   onto the other and keeps only that workflow's runs, which is what GitHub itself returns. The
 *   fake's compare commits also lack `commit.message`, which GitHub always sends and the adapter
 *   requires; it is filled in here.
 */

export interface EngineEndpoints {
  dockerHost: string;
  fakeGithubUrl: string;
  registryHostPort: number;
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** A fetch that sends `http://registry.shipyard.test/…` to the registry's published loopback port. */
export function registryFetch(registryHostPort: number): typeof fetch {
  const from = `http://${MANIFEST_REGISTRY}/`;
  const to = `http://127.0.0.1:${String(registryHostPort)}/`;
  return (input, init) => {
    const url = urlOf(input);
    return fetch(url.startsWith(from) ? to + url.slice(from.length) : url, init);
  };
}

const WORKFLOW_RUNS = /^(.*\/repos\/[^/]+\/[^/]+\/actions)\/workflows\/([^/]+)\/runs(\?.*)?$/;
const COMPARE = /\/repos\/[^/]+\/[^/]+\/compare\//;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A fetch that serves the workflow-scoped runs endpoint from the fake GitHub's `/actions/runs`. */
export function githubFetch(): typeof fetch {
  return async (input, init) => {
    const url = urlOf(input);
    if (COMPARE.test(url)) {
      const res = await fetch(url, init);
      if (!res.ok) return res;
      const body = (await res.json()) as { commits?: { sha: string; commit?: { message: string } }[] };
      const commits = (body.commits ?? []).map((c) => ({ ...c, commit: c.commit ?? { message: `commit ${c.sha.slice(0, 7)}` } }));
      return json({ ...body, commits }, res.status);
    }
    const match = WORKFLOW_RUNS.exec(url);
    if (match === null) return fetch(url, init);
    const [, prefix = '', file = '', query = ''] = match;
    const workflow = decodeURIComponent(file);
    const res = await fetch(`${prefix}/runs${query}`, init);
    if (!res.ok) return res;
    const body = (await res.json()) as { total_count: number; workflow_runs: { path: string }[] };
    const runs = body.workflow_runs.filter((run) => run.path.split('/').pop() === workflow);
    return json({ total_count: runs.length, workflow_runs: runs }, res.status);
  };
}

/** Collects log lines so a failing test can print them. */
export function memoryLog(lines: string[] = [], bindings: object = {}): Log {
  const write = (level: string) => (obj: object, msg?: string): void => {
    lines.push(`${level} ${msg ?? ''} ${JSON.stringify({ ...bindings, ...obj })}`);
  };
  return { info: write('info'), warn: write('warn'), error: write('error'), child: (more) => memoryLog(lines, { ...bindings, ...more }) };
}

export function enginePorts(endpoints: EngineEndpoints, log: Log = memoryLog()): SequencePorts {
  return {
    docker: createDockerAdapter({ dockerHost: endpoints.dockerHost }),
    github: createGitHubAdapter({ baseUrl: endpoints.fakeGithubUrl, fetch: githubFetch() }),
    registry: createRegistryAdapter({ plainHttpHosts: [MANIFEST_REGISTRY], fetch: registryFetch(endpoints.registryHostPort) }),
    fs: nodeFs(),
    clock: systemClock(),
    log,
  };
}

export interface ToyDataRoot {
  root: string;
  dataRoot: string;
  /** The stack's compose file (a copy of toy-app/compose.yml), rewritten by deploys. */
  composePath: string;
  project: string;
  journalPath: string;
  ledgerPath: string;
  workDir: string;
  historyDir: string;
  remove(): Promise<void>;
}

/**
 * A temp data root holding `apps/toy.yml` (absolute compose path, port 3000, no `expectSchema`, so
 * the image's schema label is what /health must report) and the toy stack's compose file.
 */
export interface ToyDataRootOptions {
  soakSeconds?: number;
  /**
   * More compose files for the stack, after `compose.yml`, in order: file name → content. Each is
   * written beside `compose.yml` and listed in the manifest's `compose.files`.
   */
  extraComposeFiles?: Record<string, string>;
  /** The manifest's app name (and `apps/<name>.yml`). Default `toy`. */
  app?: string;
  /** The compose service the toy app runs as, named in the manifest's services/health/migrate. Default `app`. */
  service?: string;
}

export async function prepareToyDataRoot(options: ToyDataRootOptions = {}): Promise<ToyDataRoot> {
  const root = await mkdtemp(join(tmpdir(), 'shp-e2e-engine-'));
  const dataRoot = join(root, 'data');
  const stackDir = join(root, 'stack');
  await mkdir(join(dataRoot, 'apps'), { recursive: true });
  await mkdir(join(dataRoot, 'agent'), { recursive: true });
  await mkdir(stackDir, { recursive: true });
  const composePath = join(stackDir, 'compose.yml');
  // The toy stack's own compose file, with its image line naming the alias the manifest uses.
  const toyCompose = await readFile(join(TOY_APP_DIR, 'compose.yml'), 'utf8');
  const app = options.app ?? 'toy';
  const service = options.service ?? 'app';
  const renamed = toyCompose.replace(/^ {2}app:$/m, `  ${service}:`);
  await writeFile(composePath, renamed.replaceAll(`${INTERNAL_REGISTRY}/toy/app`, `${MANIFEST_REGISTRY}/toy/app`), 'utf8');
  const project = `toy-${randomBytes(3).toString('hex')}`;
  const composeFiles = [composePath];
  for (const [name, content] of Object.entries(options.extraComposeFiles ?? {})) {
    const path = join(stackDir, name);
    await writeFile(path, content, 'utf8');
    composeFiles.push(path);
  }

  const manifest = {
    name: app,
    repo: 'example/toy',
    defaultBranch: 'main',
    workflow: 'ci.yml',
    compose: { files: composeFiles, project },
    services: { [service]: { image: `${MANIFEST_REGISTRY}/toy/app` } },
    health: { service, port: 3000, path: '/health' },
    soakSeconds: options.soakSeconds ?? 3,
    diskFloorGb: 0.1,
    steps: { migrate: { service, argv: ['node', 'migrate.mjs'] } },
  };
  await writeFile(join(dataRoot, 'apps', `${app}.yml`), stringify(manifest), 'utf8');

  return {
    root,
    dataRoot,
    composePath,
    project,
    journalPath: join(dataRoot, 'agent', 'journal.jsonl'),
    ledgerPath: join(dataRoot, 'agent', 'ledger.jsonl'),
    workDir: join(dataRoot, 'agent', 'work'),
    historyDir: join(dataRoot, 'agent', 'history'),
    remove: () => rm(root, { recursive: true, force: true }),
  };
}

export type EngineTimings = Pick<MachineContext, 'healthTimeoutMs' | 'checkIntervalMs' | 'soakIntervalMs' | 'probeTimeoutMs'>;

export const E2E_TIMINGS: EngineTimings = { healthTimeoutMs: 20_000, checkIntervalMs: 1_000, soakIntervalMs: 1_000, probeTimeoutMs: 3_000 };

/** Opens the manifests, journal and ledger from a data root, the way the agent would at start. */
export async function openContext(ports: SequencePorts, paths: ToyDataRoot | Omit<ToyDataRoot, 'remove'>, timings: EngineTimings = E2E_TIMINGS): Promise<MachineContext> {
  return {
    dataRoot: paths.dataRoot,
    manifests: await loadManifests(ports.fs, paths.dataRoot),
    journal: new Journal(ports.fs, paths.journalPath, ports.clock, ports.log),
    ledger: await Ledger.open(ports.fs, paths.ledgerPath),
    workDir: paths.workDir,
    historyDir: paths.historyDir,
    ...timings,
  };
}

/** Fake GitHub state: `shas` in order on `main`, each with a successful `ci.yml` run. */
export function linearMainState(shas: string[]): unknown {
  return {
    repos: {
      'example/toy': {
        runs: Object.fromEntries(shas.map((sha, i) => [sha, [{ workflow: 'ci.yml', conclusion: 'success', id: 100 + i }]])),
        branches: { main: shas.map((sha, i) => ({ sha, parent: i === 0 ? null : (shas[i - 1] ?? null) })) },
      },
    },
  };
}

export async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8');
}
