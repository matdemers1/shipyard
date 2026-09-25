import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { pipe, pollUntil, run, runRaw, type RunResult } from './exec.js';
import { parseManifest, type Manifest } from './manifest.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const HARNESS_COMPOSE = join(HERE, 'compose.yml');
export const TOY_APP_DIR = resolve(HERE, '../toy-app');
export const TOY_MANIFEST = join(TOY_APP_DIR, 'manifest.yml');

/** How the registry is named from inside the harness network (dind, and anything it runs). */
export const INTERNAL_REGISTRY = 'registry:5000';
/**
 * The same registry storage under a name the manifest schema accepts (no port), served on :80 to
 * dind as an insecure registry. The host reaches it through `registryHostPort`.
 */
export const MANIFEST_REGISTRY = 'registry.shipyard.test';
/** How the fake GitHub is named from inside the harness network. */
export const INTERNAL_FAKE_GITHUB = 'http://fake-github:8080';

export type ToyMode = 'pass' | 'fail-health' | 'wrong-schema' | 'fail-migrate' | 'exit-mid' | 'print-secret';

export interface ToyBuild {
  mode: ToyMode;
  /** Schema revision the image's /health reports. */
  schema: string;
  /** 40-hex commit; the tag is sha-<revision> and it is the OCI revision label. */
  revision: string;
  /** Label the release dev.d3cloud.shipyard.migration=contract. */
  contract?: boolean;
  /** Repository path in the registry. Default `toy/app`. */
  repository?: string;
  /**
   * The OCI revision label (and TOY_REVISION) baked into the image, when it should differ from the
   * `revision` the image is tagged with — an image that lies about its commit.
   */
  labelRevision?: string;
}

export interface ToyImage {
  revision: string;
  /** registry:5000/toy/app:sha-<revision> — the tag, as dind and everything inside it name it. */
  ref: string;
  /** Digest the push reported, confirmed against the registry: sha256:<64hex>. */
  digest: string;
}

export interface HealthObservation {
  /** HTTP status, or null when nothing answered. */
  status: number | null;
  /** Raw body (only available on a 2xx). */
  body: string | null;
  json: unknown;
}

export interface Deployment {
  manifest: Manifest;
  /** tag@digest image line written into the rendered compose file. */
  imageLine: string;
  renderedFiles: string[];
  migrate: RunResult | null;
  containerId: string;
  /** Image ID of the running container, per the dind daemon. */
  runningImageId: string;
  /** RepoDigests of the running image, e.g. registry:5000/toy/app@sha256:… */
  runningRepoDigests: string[];
  /** Value of org.opencontainers.image.revision on the running container. */
  revisionLabel: string | null;
  labels: Record<string, string>;
  health: HealthObservation;
}

export interface Harness {
  /** Compose project name, shp-e2e-<id>. */
  project: string;
  registryHostPort: number;
  /** tcp://127.0.0.1:<port> — the dind daemon. */
  dockerHost: string;
  /**
   * A host directory (mode 0777) mounted into dind at the same path: a stack in dind may bind-mount
   * under it and the test process reads what the containers write there (backups, data).
   */
  sharedDir: string;
  /** Fake GitHub as the host reaches it. */
  fakeGithubUrl: string;
  /** Environment for a `docker` CLI aimed at the dind daemon. */
  dindEnv(): NodeJS.ProcessEnv;
  /** Run `docker <args>` against the dind daemon. */
  dind(args: readonly string[]): Promise<RunResult>;
  /** Replace the fake GitHub's state (see fake-github/logic.d.mts StateInput). */
  setGithubState(state: unknown): Promise<void>;
  /** API requests the fake GitHub has received. */
  githubRequests(): Promise<{ method: string; url: string; authorization: string | null }[]>;
  buildToyImage(opts: ToyBuild): Promise<ToyImage>;
  deployFromManifest(manifestPath: string, sha: string): Promise<Deployment>;
  /** Tear everything down (`down -v`), remove host tags the harness made. Idempotent. */
  stop(): Promise<void>;
}

const SHA40 = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export function randomRevision(): string {
  return randomBytes(20).toString('hex');
}

function composeArgs(project: string, ...rest: string[]): string[] {
  return ['compose', '-f', HARNESS_COMPOSE, '-p', project, ...rest];
}

/** `docker compose port` prints e.g. `127.0.0.1:55012`; take the port of the first line. */
export function parsePort(output: string): number {
  const line = output.trim().split('\n')[0] ?? '';
  const port = Number(line.slice(line.lastIndexOf(':') + 1));
  if (!Number.isInteger(port) || port <= 0) throw new Error(`could not parse a port from ${JSON.stringify(output)}`);
  return port;
}

/** Container port of a compose `ports:` entry: "127.0.0.1::3000", "3000", "8080:3000/tcp", or long form. */
export function containerPortOf(entry: unknown): number {
  if (typeof entry === 'number') return entry;
  if (typeof entry === 'string') {
    const last = entry.split(':').pop() ?? '';
    const port = Number(last.split('/')[0]);
    if (Number.isInteger(port) && port > 0) return port;
  }
  if (typeof entry === 'object' && entry !== null && 'target' in entry) {
    const target = Number(entry.target);
    if (Number.isInteger(target) && target > 0) return target;
  }
  throw new Error(`cannot read a container port from ports entry ${JSON.stringify(entry)}`);
}

/** Busybox wget -S prints response headers on stderr; the last status line wins (redirects). */
export function parseWgetStatus(stderr: string): number | null {
  const matches = [...stderr.matchAll(/HTTP\/[\d.]+ (\d{3})/g)];
  const last = matches.at(-1)?.[1];
  return last === undefined ? null : Number(last);
}

export async function startHarness(): Promise<Harness> {
  const project = `shp-e2e-${randomBytes(4).toString('hex')}`;
  const hostTags = new Set<string>();
  const tempDirs = new Set<string>();
  let stopped = false;

  // Created before `up`, so dind mounts a directory the test owns and every container may write to.
  const sharedDir = await realpath(await mkdtemp(join(tmpdir(), 'shp-e2e-shared-')));
  await chmod(sharedDir, 0o777);
  tempDirs.add(sharedDir);
  const composeEnv: NodeJS.ProcessEnv = { ...process.env, SHP_E2E_SHARED_DIR: sharedDir };

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    const errors: string[] = [];
    const down = await runRaw('docker', composeArgs(project, 'down', '-v', '--remove-orphans', '--timeout', '5'), {
      env: composeEnv,
      timeoutMs: 120_000,
    });
    if (down.code !== 0) errors.push(`compose down: ${down.stderr.trim()}`);
    if (hostTags.size > 0) {
      const rmi = await runRaw('docker', ['image', 'rm', '--force', ...hostTags]);
      if (rmi.code !== 0) errors.push(`image rm: ${rmi.stderr.trim()}`);
    }
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    if (errors.length > 0) throw new Error(`harness ${project} teardown: ${errors.join('; ')}`);
  };

  try {
    await run('docker', composeArgs(project, 'up', '-d', '--quiet-pull'), { env: composeEnv, timeoutMs: 300_000 });

    const port = async (service: string, containerPort: number): Promise<number> =>
      parsePort((await run('docker', composeArgs(project, 'port', service, String(containerPort)))).stdout);
    const registryHostPort = await port('registry', 5000);
    const dindPort = await port('dind', 2375);
    const fakeGithubPort = await port('fake-github', 8080);
    const dockerHost = `tcp://127.0.0.1:${dindPort}`;
    const fakeGithubUrl = `http://127.0.0.1:${fakeGithubPort}`;
    const registryUrl = `http://127.0.0.1:${registryHostPort}`;

    const dindEnv = (): NodeJS.ProcessEnv => {
      const env: NodeJS.ProcessEnv = { ...process.env, DOCKER_HOST: dockerHost };
      delete env.DOCKER_CONTEXT;
      delete env.DOCKER_TLS_VERIFY;
      delete env.DOCKER_CERT_PATH;
      return env;
    };
    const dind = (args: readonly string[]): Promise<RunResult> =>
      run('docker', args, { env: dindEnv(), timeoutMs: 240_000 });

    // Readiness by polling, never by sleeping.
    await pollUntil('the dind daemon', async () => {
      const r = await runRaw('docker', ['info', '--format', '{{.ServerVersion}}'], {
        env: dindEnv(),
        timeoutMs: 10_000,
      });
      return r.code === 0 && r.stdout.trim().length > 0;
    });
    await pollUntil('registry:2', async () => (await fetch(`${registryUrl}/v2/`)).ok);
    await pollUntil('the fake GitHub', async () => (await fetch(`${fakeGithubUrl}/_control/requests`)).ok);

    const dindContainerId = (await run('docker', composeArgs(project, 'ps', '-q', 'dind'))).stdout.trim();
    if (dindContainerId === '') throw new Error('dind container id not found');
    await pollUntil(`${MANIFEST_REGISTRY} from dind`, async () => {
      const r = await runRaw('docker', ['exec', dindContainerId, 'wget', '-q', '-O', '-', `http://${MANIFEST_REGISTRY}/v2/`]);
      return r.code === 0;
    });

    const registryDigest = async (repository: string, tag: string): Promise<string> => {
      const res = await fetch(`${registryUrl}/v2/${repository}/manifests/${tag}`, {
        method: 'HEAD',
        headers: { accept: MANIFEST_ACCEPT },
      });
      const digest = res.headers.get('docker-content-digest');
      if (!res.ok || digest === null || !DIGEST.test(digest)) {
        throw new Error(`registry has no digest for ${repository}:${tag} (HTTP ${res.status})`);
      }
      return digest;
    };

    const buildToyImage = async (opts: ToyBuild): Promise<ToyImage> => {
      if (!SHA40.test(opts.revision)) throw new Error(`revision must be 40 hex, got ${opts.revision}`);
      const repository = opts.repository ?? 'toy/app';
      const tag = `sha-${opts.revision}`;
      const ref = `${INTERNAL_REGISTRY}/${repository}:${tag}`;
      await run(
        'docker',
        [
          'build',
          '--quiet',
          // One plain image manifest, no attestation index: the registry adapter picks linux/amd64
          // out of an index, and this image is built for the machine running the tests.
          '--provenance=false',
          '--sbom=false',
          '--build-arg',
          `TOY_MODE=${opts.mode}`,
          '--build-arg',
          `TOY_SCHEMA=${opts.schema}`,
          '--build-arg',
          `TOY_REVISION=${opts.labelRevision ?? opts.revision}`,
          '--build-arg',
          `TOY_CONTRACT=${opts.contract === true ? '1' : '0'}`,
          '--tag',
          ref,
          TOY_APP_DIR,
        ],
        { timeoutMs: 300_000 },
      );
      hostTags.add(ref);
      // Hand the image to dind and push from there: dind is configured for the plain-HTTP
      // registry:5000, whereas a Docker Desktop daemon cannot reach an ephemeral published port.
      await pipe(['save', ref], process.env, ['load', '--quiet'], dindEnv());
      const pushed = await dind(['push', ref]);
      // Drop dind's copy so a deploy really pulls tag@digest from the registry.
      await dind(['image', 'rm', ref]);
      const digest = await registryDigest(repository, tag);
      const reported = /digest: (sha256:[0-9a-f]{64})/.exec(pushed.stdout)?.[1];
      if (reported !== undefined && reported !== digest) {
        throw new Error(`push reported ${reported} but the registry holds ${digest} for ${ref}`);
      }
      return { revision: opts.revision, ref, digest };
    };

    const deployFromManifest = async (manifestPath: string, sha: string): Promise<Deployment> => {
      if (!SHA40.test(sha)) throw new Error(`sha must be 40 hex, got ${sha}`);
      const manifestDir = dirname(resolve(manifestPath));
      const manifest = parseManifest(await readFile(manifestPath, 'utf8'));

      // Resolve tag -> digest for every managed service, and pin tag@digest.
      const imageLines = new Map<string, string>();
      for (const [name, svc] of Object.entries(manifest.services)) {
        const prefix = `${INTERNAL_REGISTRY}/`;
        if (!svc.image.startsWith(prefix)) throw new Error(`services.${name}.image must live in ${INTERNAL_REGISTRY}`);
        const repository = svc.image.slice(prefix.length);
        const digest = await registryDigest(repository, `sha-${sha}`);
        imageLines.set(name, `${svc.image}:sha-${sha}@${digest}`);
      }

      // Render each compose file with its image lines rewritten; nothing else changes.
      const outDir = await mkdtemp(join(tmpdir(), `${project}-render-`));
      tempDirs.add(outDir);
      const renderedFiles: string[] = [];
      const seen = new Set<string>();
      const healthPorts: unknown[] = [];
      for (const [i, file] of manifest.compose.files.entries()) {
        const source = isAbsolute(file) ? file : join(manifestDir, file);
        const doc = parse(await readFile(source, 'utf8')) as unknown;
        if (typeof doc !== 'object' || doc === null) throw new Error(`${source}: not a compose document`);
        const services = (doc as { services?: Record<string, Record<string, unknown>> }).services ?? {};
        for (const [name, line] of imageLines) {
          const svc = services[name];
          if (svc === undefined) continue;
          if ('image' in svc) {
            svc.image = line;
            seen.add(name);
          }
        }
        const healthSvc = services[manifest.health.service];
        if (healthSvc !== undefined && Array.isArray(healthSvc.ports)) healthPorts.push(...(healthSvc.ports as unknown[]));
        const out = join(outDir, `${String(i)}-${basename(source)}`);
        await writeFile(out, stringify(doc), 'utf8');
        renderedFiles.push(out);
      }
      for (const name of imageLines.keys()) {
        if (!seen.has(name)) throw new Error(`no compose file gives service ${name} an image line`);
      }
      if (healthPorts.length === 0) throw new Error(`health service ${manifest.health.service} publishes no port`);
      const healthContainerPort = containerPortOf(healthPorts[0]);

      const compose = (...rest: string[]): Promise<RunResult> =>
        dind([
          'compose',
          '--project-directory',
          manifestDir,
          ...renderedFiles.flatMap((f) => ['-f', f]),
          '-p',
          manifest.compose.project,
          ...rest,
        ]);

      await compose('pull', '--quiet');
      const migrateStep = manifest.steps.migrate;
      const migrate =
        migrateStep === undefined ? null : await compose('run', '--rm', '--no-deps', migrateStep.service, ...migrateStep.argv);
      await compose('up', '-d', '--wait', '--remove-orphans');

      const containerId = (await compose('ps', '-q', manifest.health.service)).stdout.trim();
      if (containerId === '') throw new Error(`no running container for ${manifest.health.service}`);
      const inspected = JSON.parse((await dind(['container', 'inspect', containerId])).stdout) as {
        Image: string;
        Config: { Labels: Record<string, string> | null };
      }[];
      const container = inspected[0];
      if (container === undefined) throw new Error(`inspect returned nothing for ${containerId}`);
      const images = JSON.parse((await dind(['image', 'inspect', container.Image])).stdout) as {
        RepoDigests: string[] | null;
      }[];
      const labels = container.Config.Labels ?? {};

      const hostPort = parsePort(
        (await compose('port', manifest.health.service, String(healthContainerPort))).stdout,
      );
      // The published port lives inside dind's network namespace; ask from there.
      const healthUrl = `http://127.0.0.1:${hostPort}${manifest.health.path}`;
      let health: HealthObservation = { status: null, body: null, json: null };
      await pollUntil(
        `${manifest.name} ${manifest.health.path}`,
        async () => {
          const r = await runRaw('docker', ['exec', dindContainerId, 'wget', '-S', '-q', '-T', '5', '-O', '-', healthUrl]);
          const status = parseWgetStatus(r.stderr);
          if (status === null) return false;
          let json: unknown = null;
          if (r.code === 0) {
            try {
              json = JSON.parse(r.stdout) as unknown;
            } catch {
              json = null;
            }
          }
          health = { status, body: r.code === 0 ? r.stdout : null, json };
          return true;
        },
        { timeoutMs: 30_000 },
      );

      return {
        manifest,
        imageLine: imageLines.get(manifest.health.service) ?? '',
        renderedFiles,
        migrate,
        containerId,
        runningImageId: container.Image,
        runningRepoDigests: images[0]?.RepoDigests ?? [],
        revisionLabel: labels['org.opencontainers.image.revision'] ?? null,
        labels,
        health,
      };
    };

    const setGithubState = async (state: unknown): Promise<void> => {
      const res = await fetch(`${fakeGithubUrl}/_control/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(state),
      });
      if (res.status !== 204) throw new Error(`fake GitHub refused state: ${res.status} ${await res.text()}`);
    };

    const githubRequests = async (): Promise<{ method: string; url: string; authorization: string | null }[]> => {
      const res = await fetch(`${fakeGithubUrl}/_control/requests`);
      return (await res.json()) as { method: string; url: string; authorization: string | null }[];
    };

    return {
      project,
      registryHostPort,
      dockerHost,
      sharedDir,
      fakeGithubUrl,
      dindEnv,
      dind,
      setGithubState,
      githubRequests,
      buildToyImage,
      deployFromManifest,
      stop,
    };
  } catch (err) {
    // Setup failed: leave nothing behind, then report the original error.
    await stop().catch((teardown: unknown) => {
      console.error(teardown);
    });
    throw err;
  }
}
