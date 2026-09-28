import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { refusal } from '@shipyard/schema';
import type { Manifest } from '@shipyard/schema';
import { Document } from 'yaml';

import { RefusalError } from '../ports.js';
import type { BuildSecretMount, ComposeTarget, DockerPort, ExecResult, Log, SolveRequest, SolveResult } from '../ports.js';
import { INTEGRATION_GATEWAY_MODE_OPTION, INTEGRATION_SUBNET_SLOTS, integrationNetworkSlot, integrationSubnetSlot } from './network.js';

/**
 * The integration test stage (SHP-T-7.8): the hook `runBuildStages` calls between the test target
 * and the release targets.
 *
 * 1. **Inspect** the manifest's integration compose file with `docker compose config --no-interpolate
 *    --format json` (compose's own normalised model — `extends`, `include`, short syntax all
 *    resolved) and **refuse** it when it uses anything that would reach outside the build: published
 *    ports, `privileged`, `network_mode`, host `pid`/`ipc`/`uts`/`userns`/`cgroup`, `cap_add`,
 *    `devices`, `security_opt`, `sysctls`, host bind mounts (including a `local` volume with `driver_opts`),
 *    external or foreign-named volumes and networks, `volumes_from`, `external_links`, any network
 *    but `default`, `ipam` or `driver_opts` on `default` (Shipyard sets both), a sidecar with `build:` (that would build on the host daemon, outside the build
 *    network), env files or secret/config files outside the source tree, and any `${VAR}`
 *    interpolation (compose would fill it from the agent's own environment). Refusing rather than
 *    stripping is deliberate: a silently stripped port or mount makes a test pass or fail for a
 *    reason nobody can see, whereas a refusal names the line to change. Every compose call passes
 *    `--env-file` pointing at an empty file, so the repository's `.env` is never read.
 * 2. **Build** the test target with BuildKit, exported as a docker-loadable tar
 *    (`--output type=docker,name=shipyard-build/<app>:<buildId>,dest=…`), and `docker load` it.
 * 3. **Run** it as compose project `shipyard-build-<buildId>` (SHP-REQ-119) with the source file plus
 *    a generated override that pins the integration service to the loaded image (`pull_policy:
 *    never`, any `build:` reset) and makes the project's one network, `default`, `internal: true`
 *    with IPv6 off, bridge gateway mode `isolated` (the host takes no address on it), a /24 from
 *    `INTEGRATION_SUBNET_POOL` and a `shp-it-<n>` bridge name that `build-network.sh` firewalls off
 *    the host — every service is on it and nothing on it has a route anywhere else, the Docker host
 *    included (SHP-REQ-123; see network.ts). `compose create` makes the network, volumes and
 *    containers first; when the daemon reports the subnet overlaps an existing network, the stage
 *    takes the next slot of the pool and tries again. `compose run --rm -T <service> <argv…>` then
 *    starts the sidecars, runs the service
 *    with the manifest's argv (an array, never a string; absent → the image's default command) under
 *    a timeout, and exit 0 is a pass.
 * 4. **Always tear down** (SHP-REQ-121), on pass, fail, throw or cancel: `compose down -v
 *    --remove-orphans` (containers, the network, named and anonymous volumes); if a cancelled
 *    `compose run` was still starting, wait for it and run `down` again so nothing it creates
 *    afterwards survives; remove the loaded image; delete the work directory.
 */

/** Where BuildKit writes a docker-loadable tar of the built image. */
export interface DockerTarExport {
  /** The image name baked into the tar, e.g. `shipyard-build/toy:<buildId>`. */
  name: string;
  /** Absolute path of the tar to write. */
  dest: string;
}

/**
 * The export seam. `SolveRequest` (ports.ts) can only build or push; it cannot yet name a
 * `type=docker` output. Until it gains one, the agent wires this with a one-liner over its
 * `BuildKitPort` (see the SHP-T-7.8 hand-off), and tests pass a fake.
 */
export interface TestImageBuilder {
  solveToDockerTar(req: SolveRequest, out: DockerTarExport, onLog?: (chunk: string) => void, signal?: AbortSignal): Promise<SolveResult>;
}

/** `docker load -i <tar>`: not yet on `DockerPort` (ports.ts is shared). Never throws on a non-zero exit. */
export interface ImageLoader {
  loadImage(tarPath: string): Promise<ExecResult>;
}

export type IntegrationDocker = Pick<DockerPort, 'compose' | 'removeImage'> & ImageLoader;

export interface IntegrationStageOptions {
  docker: IntegrationDocker;
  buildkit: TestImageBuilder;
  /** The extracted source directory (from `withBuildSource`). */
  dir: string;
  manifest: Manifest;
  /** The build's ID; lowercased into the project name `shipyard-build-<id>`. */
  buildId: string;
  sha: string;
  /** Where the stage's work directory (override file, empty env file, image tar) is made. */
  tmpDir: string;
  /** Build secret values, mounted into the test-target export as in the test stage. Never logged. */
  secrets?: Map<string, string>;
  /** The per-build network's Docker name. Default `shipyard-build-<id>_default`. Must start `shipyard-build-`. */
  networkName?: string;
  /** Limit for `compose run`. Default 15 minutes. */
  timeoutMs?: number;
  /** Aborting it cancels the stage: the run is torn down and the hook resolves false. */
  signal?: AbortSignal;
  log?: Log;
}

export type IntegrationHook = (ctx: { onLog: (chunk: string) => void }) => Promise<boolean>;

export const INTEGRATION_PROJECT_PREFIX = 'shipyard-build-';
export const DEFAULT_INTEGRATION_TIMEOUT_MS = 15 * 60_000;
/** How long teardown waits for a cancelled `compose run` to exit before its second `down`. */
const RUN_SETTLE_MS = 60_000;
/** How many slots of the subnet pool `compose create` tries before the stage gives up. */
export const INTEGRATION_SUBNET_ATTEMPTS = 8;
/** The daemon's answer when a requested subnet overlaps an existing network. */
const POOL_OVERLAP_RE = /pool overlaps|overlaps with/i;
const BUILD_ID_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

/** `shipyard-build-<buildId>` (lowercased); refuses an ID compose would not accept as a project name. */
export function integrationProjectName(buildId: string): string {
  const id = buildId.toLowerCase();
  if (!BUILD_ID_RE.test(id)) {
    throw new RefusalError(refusal('invalid_request', `build ID '${buildId}' cannot name a compose project`));
  }
  return `${INTEGRATION_PROJECT_PREFIX}${id}`;
}

/** The loaded test image's reference: `shipyard-build/<app>:<buildId>`. */
export function integrationImageRef(app: string, buildId: string): string {
  return `shipyard-build/${app}:${buildId.toLowerCase()}`;
}

// ─── The compose model check ─────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A model value for a refusal message. */
const show = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));
const nonEmpty = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : isObj(v) ? Object.keys(v).length > 0 : v !== undefined && v !== null && v !== '' && v !== false);

function insideDir(dir: string, path: string): boolean {
  const abs = isAbsolute(path) ? path : resolve(dir, path);
  const rel = relative(dir, abs);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Every `$VAR` / `${VAR}` left in the un-interpolated model, after removing `$$` escapes. */
function interpolations(value: unknown, path: string, out: string[]): void {
  if (typeof value === 'string') {
    if (/\$(\{|[A-Za-z_])/.test(value.replaceAll('$$', ''))) out.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => {
      interpolations(v, `${path}[${String(i)}]`, out);
    });
  } else if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) interpolations(v, path === '' ? k : `${path}.${k}`, out);
  }
}

export interface ComposeCheckContext {
  /** The extracted source directory; env files and secret/config files must be inside it. */
  dir: string;
  project: string;
  /** The integration service. */
  service: string;
}

/**
 * What in a normalised compose model (`docker compose config --no-interpolate --format json`)
 * the integration stage refuses to run (SHP-REQ-123). Empty when the model is acceptable.
 */
export function composeModelProblems(model: unknown, ctx: ComposeCheckContext): string[] {
  const problems: string[] = [];
  if (!isObj(model) || !isObj(model.services)) return ['the compose file defines no services'];
  const services = model.services;
  if (!isObj(services[ctx.service])) problems.push(`the integration service ${ctx.service} is not defined in the compose file`);

  const volumes = isObj(model.volumes) ? model.volumes : {};
  for (const [name, raw] of Object.entries(volumes)) {
    const v = isObj(raw) ? raw : {};
    if (nonEmpty(v.external)) problems.push(`volume ${name} is external`);
    if (v.name !== undefined && v.name !== `${ctx.project}_${name}`) problems.push(`volume ${name} names another volume (${show(v.name)})`);
    if (v.driver !== undefined && v.driver !== 'local') problems.push(`volume ${name} uses driver ${show(v.driver)}`);
    if (nonEmpty(v.driver_opts)) problems.push(`volume ${name} sets driver_opts (a local volume with driver_opts can bind a host path)`);
  }

  const networks = isObj(model.networks) ? model.networks : {};
  for (const [name, raw] of Object.entries(networks)) {
    if (name !== 'default') {
      problems.push(`network ${name} is declared; integration services share one per-build network, default`);
      continue;
    }
    const n = isObj(raw) ? raw : {};
    if (nonEmpty(n.external)) problems.push('network default is external');
    if (n.name !== undefined && n.name !== `${ctx.project}_default`) problems.push(`network default names another network (${show(n.name)})`);
    if (n.driver !== undefined && n.driver !== 'bridge') problems.push(`network default uses driver ${show(n.driver)}`);
    if (nonEmpty(n.driver_opts)) problems.push('network default sets driver_opts (Shipyard sets the bridge options)');
    const ipam = isObj(n.ipam) ? n.ipam : {};
    if (nonEmpty(ipam.config) || nonEmpty(ipam.driver) || nonEmpty(ipam.options)) problems.push('network default sets ipam (Shipyard allocates the subnet)');
  }

  for (const kind of ['secrets', 'configs'] as const) {
    const entries = isObj(model[kind]) ? model[kind] : {};
    for (const [name, raw] of Object.entries(entries)) {
      const e = isObj(raw) ? raw : {};
      if (nonEmpty(e.external)) problems.push(`${kind} ${name} is external`);
      if (e.environment !== undefined) problems.push(`${kind} ${name} reads the agent's environment`);
      if (typeof e.file === 'string' && !insideDir(ctx.dir, e.file)) problems.push(`${kind} ${name} reads a file outside the source tree`);
    }
  }

  for (const [name, raw] of Object.entries(services)) {
    if (!isObj(raw)) continue;
    const s = raw;
    const at = `service ${name}`;
    if (s.build !== undefined && name !== ctx.service) problems.push(`${at} has build: (a sidecar must be an image; a compose build runs on the host daemon)`);
    if (nonEmpty(s.ports)) problems.push(`${at} publishes ports`);
    if (s.privileged === true) problems.push(`${at} is privileged`);
    if (s.network_mode !== undefined) problems.push(`${at} sets network_mode`);
    if (isObj(s.networks)) {
      for (const net of Object.keys(s.networks)) if (net !== 'default') problems.push(`${at} joins network ${net}`);
    }
    if (s.pid !== undefined && s.pid !== '') problems.push(`${at} sets pid`);
    if (typeof s.ipc === 'string' && s.ipc !== '' && s.ipc !== 'private' && s.ipc !== 'shareable') problems.push(`${at} sets ipc: ${s.ipc}`);
    if (s.uts !== undefined && s.uts !== '') problems.push(`${at} sets uts`);
    if (s.userns_mode !== undefined && s.userns_mode !== '') problems.push(`${at} sets userns_mode`);
    if (s.cgroup === 'host') problems.push(`${at} sets cgroup: host`);
    if (nonEmpty(s.cgroup_parent)) problems.push(`${at} sets cgroup_parent`);
    if (nonEmpty(s.cap_add)) problems.push(`${at} adds capabilities`);
    if (nonEmpty(s.devices)) problems.push(`${at} maps devices`);
    if (nonEmpty(s.device_cgroup_rules)) problems.push(`${at} sets device_cgroup_rules`);
    if (nonEmpty(s.security_opt)) problems.push(`${at} sets security_opt`);
    if (nonEmpty(s.sysctls)) problems.push(`${at} sets sysctls`);
    if (nonEmpty(s.volumes_from)) problems.push(`${at} uses volumes_from`);
    if (nonEmpty(s.external_links)) problems.push(`${at} uses external_links`);
    if (Array.isArray(s.volumes)) {
      for (const rawMount of s.volumes) {
        const m = isObj(rawMount) ? rawMount : {};
        const type = typeof m.type === 'string' ? m.type : typeof rawMount === 'string' ? 'bind' : 'unknown';
        if (type === 'tmpfs' || type === 'image') continue;
        if (type === 'volume') {
          if (typeof m.source === 'string' && m.source !== '' && !(m.source in volumes)) problems.push(`${at} mounts undeclared volume ${m.source}`);
          continue;
        }
        const target = typeof m.target === 'string' ? m.target : '?';
        problems.push(`${at} mounts a ${type} at ${target} (host bind mounts are refused)`);
      }
    }
    const envFiles = Array.isArray(s.env_file) ? s.env_file : s.env_file === undefined ? [] : [s.env_file];
    for (const f of envFiles) {
      const path = typeof f === 'string' ? f : isObj(f) && typeof f.path === 'string' ? f.path : undefined;
      if (path === undefined || !insideDir(ctx.dir, path)) problems.push(`${at} reads an env_file outside the source tree`);
    }
  }

  const interp: string[] = [];
  interpolations(model, '', interp);
  for (const path of interp) problems.push(`${path} uses \${…} interpolation (compose would fill it from the agent's environment)`);
  return problems;
}

/** The generated override (YAML) layered after the source compose file. */
export function renderIntegrationOverride(opts: { service: string; image: string; resetBuild: boolean; networkName: string; subnet: string; bridge: string }): string {
  const doc = new Document({
    services: {
      [opts.service]: { image: opts.image, pull_policy: 'never' },
    },
    networks: {
      default: {
        name: opts.networkName,
        driver: 'bridge',
        internal: true,
        enable_ipv6: false,
        driver_opts: {
          'com.docker.network.bridge.name': opts.bridge,
          [INTEGRATION_GATEWAY_MODE_OPTION]: 'isolated',
        },
        ipam: { config: [{ subnet: opts.subnet }] },
      },
    },
  });
  if (opts.resetBuild) {
    const reset = doc.createNode(null);
    reset.tag = '!reset';
    doc.setIn(['services', opts.service, 'build'], reset);
  }
  return `# Generated by Shipyard for one integration run (SHP-T-7.8). Do not edit.\n${doc.toString()}`;
}

// ─── The stage ───────────────────────────────────────────────────────────────

function emit(onLog: (chunk: string) => void, result: ExecResult): void {
  if (result.stdout !== '') onLog(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
  if (result.stderr !== '') onLog(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
}

function refuseCompose(message: string, fix: string): never {
  throw new RefusalError(refusal('manifest_invalid', message, fix));
}

/**
 * Builds the `integration` hook for `runBuildStages` (SHP-REQ-119, SHP-REQ-121, SHP-REQ-123).
 * Throws `RefusalError` synchronously for a bad build ID or network name, and from the hook for a
 * compose file it refuses to run; otherwise the hook resolves true only when the service exited 0.
 */
export function createIntegrationStage(options: IntegrationStageOptions): IntegrationHook {
  const integration = options.manifest.build?.integration;
  if (integration === undefined) {
    throw new RefusalError(refusal('invalid_request', `app ${options.manifest.name} names no build.integration service`));
  }
  if (!SHA_RE.test(options.sha)) throw new RefusalError(refusal('invalid_request', 'build sha must be 40 lowercase hex characters'));
  const project = integrationProjectName(options.buildId);
  const networkName = options.networkName ?? `${project}_default`;
  if (!networkName.startsWith(INTEGRATION_PROJECT_PREFIX) || !/^[a-z0-9][a-z0-9_.-]*$/.test(networkName)) {
    throw new RefusalError(refusal('invalid_request', `integration network '${networkName}' must be named ${INTEGRATION_PROJECT_PREFIX}…`));
  }
  const imageRef = integrationImageRef(options.manifest.name, options.buildId);
  const timeoutMs = options.timeoutMs ?? DEFAULT_INTEGRATION_TIMEOUT_MS;
  const { docker, buildkit, signal } = options;
  const aborted = (): boolean => signal?.aborted === true;

  return async ({ onLog }) => {
    const dir = await realpath(options.dir);
    const composeFile = join(dir, integration.compose);
    let resolvedCompose: string;
    try {
      resolvedCompose = await realpath(composeFile);
    } catch {
      refuseCompose(`build.integration.compose ${integration.compose} does not exist in the source`, 'Point build.integration.compose at a compose file in the repository.');
    }
    if (!insideDir(dir, resolvedCompose)) {
      refuseCompose(`build.integration.compose ${integration.compose} resolves outside the source`, 'Point build.integration.compose at a compose file in the repository.');
    }

    const work = await mkdtemp(join(options.tmpDir, 'shipyard-integration-'));
    await chmod(work, 0o700);
    const envFile = join(work, 'empty.env');
    const overrideFile = join(work, 'shipyard-integration.override.yml');
    const envArgs = ['--env-file', envFile];
    const target: ComposeTarget = { files: [composeFile, overrideFile], project };

    let composeTouched = false;
    let imageLoaded = false;
    let running: Promise<ExecResult> | undefined;
    /** Set from the run promise's callback; an object so the finally block's check is not narrowed away. */
    const run = { settled: false };
    let secretDir: string | undefined;

    const down = async (): Promise<void> => {
      const result = await docker.compose(target, [...envArgs, 'down', '-v', '--remove-orphans', '--timeout', '5']);
      if (result.exitCode !== 0) {
        onLog(`integration teardown: compose down exited ${String(result.exitCode)}\n`);
        emit(onLog, result);
        options.log?.warn({ project, exitCode: result.exitCode }, 'integration teardown did not complete');
      }
    };

    try {
      await writeFile(envFile, '', { mode: 0o600 });
      if (aborted()) return false;

      // ── 1. inspect and refuse ──
      const config = await docker.compose({ files: [composeFile], project }, [...envArgs, 'config', '--no-interpolate', '--format', 'json']);
      if (config.exitCode !== 0) {
        emit(onLog, config);
        refuseCompose(`compose could not read ${integration.compose} (exit ${String(config.exitCode)})`, 'Fix the integration compose file; `docker compose config` must accept it.');
      }
      let model: unknown;
      try {
        model = JSON.parse(config.stdout) as unknown;
      } catch {
        refuseCompose(`compose config for ${integration.compose} was not JSON`, 'Check the agent runs docker compose v2.2x or v5.');
      }
      const problems = composeModelProblems(model, { dir, project, service: integration.service });
      if (problems.length > 0) {
        refuseCompose(
          `the integration compose file ${integration.compose} is refused: ${problems.join('; ')}`,
          'Remove these from the integration compose file; integration tests run on an internal per-build network with no host access (SHP-REQ-123).',
        );
      }
      const services = (model as { services: Obj }).services;
      const resetBuild = isObj(services[integration.service]) && (services[integration.service] as Obj).build !== undefined;
      const writeOverride = async (slot: number): Promise<void> => {
        const { subnet, bridge } = integrationNetworkSlot(slot);
        await writeFile(overrideFile, renderIntegrationOverride({ service: integration.service, image: imageRef, resetBuild, networkName, subnet, bridge }), { mode: 0o600 });
      };
      const firstSlot = integrationSubnetSlot(options.buildId);
      await writeOverride(firstSlot);

      // ── 2. build the test target as a docker tar and load it ──
      const build = options.manifest.build;
      const secretMounts: BuildSecretMount[] = [];
      const names = build?.secrets ?? [];
      if (names.length > 0 && options.secrets !== undefined) {
        secretDir = await mkdtemp(join(work, 'secrets-'));
        await chmod(secretDir, 0o700);
        for (const name of names) {
          const value = options.secrets.get(name);
          if (value === undefined) continue;
          const src = join(secretDir, name);
          await writeFile(src, value, { mode: 0o600 });
          secretMounts.push({ id: name, src });
        }
      }
      const tar = join(work, 'image.tar');
      if (aborted()) return false;
      onLog(`integration: exporting target ${build?.testTarget ?? 'test'} as ${imageRef}\n`);
      const solved = await buildkit.solveToDockerTar(
        {
          contextDir: dir,
          dockerfile: join(dir, build?.dockerfile ?? 'Dockerfile'),
          target: build?.testTarget ?? 'test',
          secrets: secretMounts,
          labels: { 'org.opencontainers.image.revision': options.sha },
        },
        { name: imageRef, dest: tar },
        onLog,
        signal,
      );
      if (secretDir !== undefined) {
        await rm(secretDir, { recursive: true, force: true });
        secretDir = undefined;
      }
      if (solved.exitCode !== 0) {
        onLog(`integration: exporting the test image failed (exit ${String(solved.exitCode)})\n`);
        return false;
      }
      if (aborted()) return false;
      imageLoaded = true;
      const loaded = await docker.loadImage(tar);
      emit(onLog, loaded);
      await rm(tar, { force: true });
      if (loaded.exitCode !== 0) {
        onLog(`integration: docker load failed (exit ${String(loaded.exitCode)})\n`);
        return false;
      }
      if (aborted()) return false;

      // ── 3. create the project (network from the pool, retrying on overlap), then run ──
      composeTouched = true;
      let created = false;
      for (let attempt = 0; attempt < INTEGRATION_SUBNET_ATTEMPTS; attempt++) {
        const slot = (firstSlot + attempt) % INTEGRATION_SUBNET_SLOTS;
        if (attempt > 0) {
          await down();
          await writeOverride(slot);
        }
        const create = await docker.compose(target, [...envArgs, 'create']);
        if (create.exitCode === 0) {
          created = true;
          break;
        }
        const overlap = POOL_OVERLAP_RE.test(`${create.stdout}\n${create.stderr}`);
        if (!overlap) {
          emit(onLog, create);
          onLog(`integration: compose create failed (exit ${String(create.exitCode)})\n`);
          return false;
        }
        onLog(`integration: subnet ${integrationNetworkSlot(slot).subnet} is taken; trying the next\n`);
        if (aborted()) return false;
      }
      if (!created) {
        onLog(`integration: no free subnet after ${String(INTEGRATION_SUBNET_ATTEMPTS)} tries in the build pool\n`);
        return false;
      }
      if (aborted()) return false;
      const runArgs = [...envArgs, 'run', '--rm', '-T', integration.service, ...(integration.argv ?? [])];
      running = docker.compose(target, runArgs, { timeoutMs });
      const settle = (): void => {
        run.settled = true;
      };
      running.then(settle, settle);
      const outcome = await raceAbort(running, signal);
      if (outcome === 'aborted') {
        onLog('integration: cancelled; tearing down\n');
        return false;
      }
      emit(onLog, outcome);
      if (outcome.exitCode === 124) onLog(`integration: ${integration.service} ran past ${String(timeoutMs)}ms and was stopped\n`);
      onLog(`integration: ${integration.service} exited ${String(outcome.exitCode)}\n`);
      return outcome.exitCode === 0;
    } finally {
      // ── 4. teardown, whatever happened (SHP-REQ-121) ──
      if (secretDir !== undefined) await rm(secretDir, { recursive: true, force: true });
      if (composeTouched) {
        await down();
        if (running !== undefined && !run.settled) {
          await Promise.race([running, new Promise((r) => setTimeout(r, RUN_SETTLE_MS).unref())]);
          await down();
        }
      }
      if (imageLoaded) {
        try {
          await docker.removeImage(imageRef);
        } catch (err) {
          onLog(`integration teardown: could not remove ${imageRef}\n`);
          options.log?.warn({ image: imageRef, err: err instanceof Error ? err.message : String(err) }, 'integration image not removed');
        }
      }
      await rm(work, { recursive: true, force: true });
    }
  };
}

/** Resolves with the run's result, or `'aborted'` as soon as the signal fires. */
function raceAbort(running: Promise<ExecResult>, signal: AbortSignal | undefined): Promise<ExecResult | 'aborted'> {
  if (signal === undefined) return running;
  if (signal.aborted) return Promise.resolve('aborted');
  return new Promise((resolvePromise, reject) => {
    const onAbort = (): void => {
      resolvePromise('aborted');
    };
    signal.addEventListener('abort', onAbort, { once: true });
    running.then(
      (r) => {
        signal.removeEventListener('abort', onAbort);
        resolvePromise(r);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
