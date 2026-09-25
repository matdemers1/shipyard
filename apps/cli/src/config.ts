import { createDockerAdapter, createGitHubAdapter, createRegistryAdapter, dockerConfigCredentials, nodeFs, systemClock } from '@shipyard/sequence';
import type { Log, SequencePorts } from '@shipyard/sequence';

/**
 * Env → ports wiring (SHP-T-1.12). No deploy logic lives here: this only assembles the same
 * adapters the agent uses, from environment configuration, plus two fetch wrappers that bridge a
 * test double onto the real adapter's URLs — the same bridging `e2e/harness/engine.ts` performs
 * for the in-process harness, needed again here because a spawned CLI process cannot import that
 * harness module.
 */

export interface Sink {
  write(chunk: string): void;
}

export interface EnvConfig {
  dataRoot: string;
  dockerHost: string | undefined;
  githubApi: string;
  githubToken: string | undefined;
  plainHttpRegistries: string[];
  registryAlias: { from: string; to: string } | undefined;
}

const DEFAULT_GITHUB_API = 'https://api.github.com';

function parseRegistryAlias(value: string | undefined): { from: string; to: string } | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const idx = value.indexOf('=');
  if (idx === -1) throw new Error(`SHIPYARD_REGISTRY_ALIAS must be "<host>=<host:port>", got "${value}"`);
  const from = value.slice(0, idx);
  const to = value.slice(idx + 1);
  if (from.length === 0 || to.length === 0) throw new Error(`SHIPYARD_REGISTRY_ALIAS must be "<host>=<host:port>", got "${value}"`);
  return { from, to };
}

/** Reads and validates the env; a missing `SHIPYARD_DATA_ROOT` or malformed alias is reported, never thrown. */
export function readEnvConfig(env: NodeJS.ProcessEnv): { ok: true; config: EnvConfig } | { ok: false; message: string } {
  const dataRoot = env.SHIPYARD_DATA_ROOT;
  if (dataRoot === undefined || dataRoot.trim() === '') {
    return { ok: false, message: 'SHIPYARD_DATA_ROOT is required' };
  }

  let registryAlias: { from: string; to: string } | undefined;
  try {
    registryAlias = parseRegistryAlias(env.SHIPYARD_REGISTRY_ALIAS);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  const plainHttpRegistries = (env.SHIPYARD_PLAIN_HTTP_REGISTRIES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return {
    ok: true,
    config: {
      dataRoot,
      dockerHost: env.DOCKER_HOST,
      githubApi: env.SHIPYARD_GITHUB_API ?? DEFAULT_GITHUB_API,
      githubToken: env.GITHUB_TOKEN_AGENT,
      plainHttpRegistries,
      registryAlias,
    },
  };
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Rewrites `http://<alias.from>/…` onto `http://<alias.to>/…`; anything else passes through untouched. */
function aliasFetch(alias: { from: string; to: string }): typeof fetch {
  const from = `http://${alias.from}/`;
  const to = `http://${alias.to}/`;
  return (input, init) => {
    const url = urlOf(input);
    return fetch(url.startsWith(from) ? to + url.slice(from.length) : url, init);
  };
}

const WORKFLOW_RUNS = /^(.*\/repos\/[^/]+\/[^/]+\/actions)\/workflows\/([^/]+)\/runs(\?.*)?$/;
const COMPARE = /\/repos\/[^/]+\/[^/]+\/compare\//;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * A fetch that serves the workflow-scoped runs endpoint from a fake GitHub's plain `/actions/runs`,
 * and fills in `commit.message` on compare results when the fake omits it — mirroring
 * `e2e/harness/engine.ts`'s `githubFetch`, since a spawned process cannot share that module. Only
 * wired in when `SHIPYARD_GITHUB_API` points away from the real API.
 */
function bridgeGithubFetch(): typeof fetch {
  return async (input, init) => {
    const url = urlOf(input);
    if (COMPARE.test(url)) {
      const res = await fetch(url, init);
      if (!res.ok) return res;
      const body = (await res.json()) as { commits?: { sha: string; commit?: { message: string } }[] };
      const commits = (body.commits ?? []).map((c) => ({ ...c, commit: c.commit ?? { message: `commit ${c.sha.slice(0, 7)}` } }));
      return jsonResponse({ ...body, commits }, res.status);
    }
    const match = WORKFLOW_RUNS.exec(url);
    if (match === null) return fetch(url, init);
    const [, prefix = '', file = '', query = ''] = match;
    const workflow = decodeURIComponent(file);
    const res = await fetch(`${prefix}/runs${query}`, init);
    if (!res.ok) return res;
    const body = (await res.json()) as { total_count: number; workflow_runs: { path: string }[] };
    const runs = body.workflow_runs.filter((run) => run.path.split('/').pop() === workflow);
    return jsonResponse({ total_count: runs.length, workflow_runs: runs }, res.status);
  };
}

/** A pino-compatible logger that writes one JSON object per line to `sink` (stderr in production). */
export function jsonLog(sink: Sink, bindings: Record<string, unknown> = {}): Log {
  const write =
    (level: string) =>
    (obj: object, msg?: string): void => {
      sink.write(`${JSON.stringify({ level, time: new Date().toISOString(), ...bindings, ...obj, ...(msg === undefined ? {} : { msg }) })}\n`);
    };
  return { info: write('info'), warn: write('warn'), error: write('error'), child: (more) => jsonLog(sink, { ...bindings, ...more }) };
}

/** Assembles the same adapters the agent uses, from env configuration. No deploy logic. */
export function buildPorts(config: EnvConfig, stderr: Sink): SequencePorts {
  const bridged = config.githubApi !== DEFAULT_GITHUB_API;
  const plainHttpHosts = [...config.plainHttpRegistries, ...(config.registryAlias ? [config.registryAlias.from] : [])];

  return {
    docker: createDockerAdapter({ ...(config.dockerHost === undefined ? {} : { dockerHost: config.dockerHost }) }),
    github: createGitHubAdapter({
      baseUrl: config.githubApi,
      ...(config.githubToken === undefined ? {} : { token: config.githubToken }),
      ...(bridged ? { fetch: bridgeGithubFetch() } : {}),
    }),
    registry: createRegistryAdapter({
      credentials: dockerConfigCredentials(process.env.DOCKER_CONFIG),
      ...(plainHttpHosts.length > 0 ? { plainHttpHosts } : {}),
      ...(config.registryAlias ? { fetch: aliasFetch(config.registryAlias) } : {}),
    }),
    fs: nodeFs(),
    clock: systemClock(),
    log: jsonLog(stderr),
  };
}
