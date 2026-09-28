import { randomBytes, randomInt } from 'node:crypto';
import { chmod, copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { BUILD_NETWORK_NAME, createBuildKitAdapter, runArgv, type BuildKitPort, type SolveRequest } from '@shipyard/sequence';
import { parse } from 'yaml';

import { pipe, pollUntil, run, runRaw } from './exec.js';
import { HARNESS_COMPOSE, MANIFEST_REGISTRY, TOY_APP_DIR, type Harness } from './harness.js';

/**
 * The build side of the harness (SHP-T-7.16): a rootless BuildKit daemon inside dind on the real
 * `shipyard-build` network, the real BuildKit adapter talking to it, and GitHub-style source
 * tarballs of the toy app for the fake GitHub to serve.
 *
 * - **The operator script runs for real** (`docs/install/build-network.sh`, inside dind), so every
 *   build step is under the same firewall a host's builds are: no RFC1918, no Docker host.
 * - **The registry is reached on a non-RFC1918 address.** The harness network is private address
 *   space, which that firewall drops — as it should. So, as GHCR is public for a real host, a
 *   random `198.18.x.0/24` network (the benchmarking range) is made on the outer daemon, the
 *   `registry-alias` container (port 80, `registry.shipyard.test`) and dind join it, and buildkitd
 *   resolves `registry.shipyard.test` to that address (`--add-host`). A plain-HTTP registry needs
 *   a `buildkitd.toml` saying so.
 * - **`buildctl` runs inside the buildkitd container** (`docker exec`), through the adapter's
 *   `execFile` seam: the adapter still builds the argv. The source and metadata directories live
 *   under the harness's `sharedDir`, which is mounted into buildkitd at the same path, so the paths
 *   the adapter names are real on both sides. It runs as root in the container so it can read the
 *   0700 scratch directory the host user made.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const INSTALL_DIR = resolve(HERE, '../../docs/install');
export const BUILDKIT_SOCK = 'unix:///run/user/1000/buildkit/buildkitd.sock';

/** The image `docs/install/buildkit.compose.yml` pins: the one production runs. */
export async function buildkitImage(): Promise<string> {
  const compose = parse(await readFile(join(INSTALL_DIR, 'buildkit.compose.yml'), 'utf8')) as { services: { buildkitd: { image: string } } };
  return compose.services.buildkitd.image;
}

// ── source tarballs ────────────────────────────────────────────────────────────────────────────

export interface TarFile {
  /** Relative to the archive's top directory. */
  path: string;
  data: Buffer | string;
  mode?: number;
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function tarHeader(name: string, size: number, mode: number, type: '0' | '5'): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar entry name too long: ${name}`);
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii');
  h.write(octal(0, 8), 116, 8, 'ascii');
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(Math.floor(Date.now() / 1000), 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii');
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

/** A gzipped ustar archive with one top directory, the way GitHub's tarball endpoint shapes it. */
export function tarGz(topDir: string, files: readonly TarFile[]): Buffer {
  const parts: Buffer[] = [tarHeader(`${topDir}/`, 0, 0o755, '5')];
  for (const file of files) {
    const data = typeof file.data === 'string' ? Buffer.from(file.data, 'utf8') : file.data;
    parts.push(tarHeader(`${topDir}/${file.path}`, data.length, file.mode ?? 0o644, '0'), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad > 0) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

export interface ToySourceOptions {
  /** Add `TOY_TEST_FAIL`: the Dockerfile's `test` target then exits 1. */
  failTests?: boolean;
  /** URLs the test target fetches once each, printing `TOY-PROBE <url> reached|blocked`. */
  probes?: string[];
}

/**
 * The toy app's source at `sha` as GitHub would serve it: `e2e/toy-app/*` under
 * `<owner>-<repo>-<sha7>/`, plus `SOURCE_SHA` (so every commit's COPY layer differs and its test
 * step really runs) and the options' files. Base64, ready for the fake GitHub's `tarballs`.
 */
export async function toySourceTarball(repo: string, sha: string, options: ToySourceOptions = {}): Promise<string> {
  const files: TarFile[] = [];
  for (const entry of await readdir(TOY_APP_DIR, { withFileTypes: true })) {
    if (entry.isFile()) files.push({ path: entry.name, data: await readFile(join(TOY_APP_DIR, entry.name)) });
  }
  files.push({ path: 'SOURCE_SHA', data: `${sha}\n` });
  if (options.failTests === true) files.push({ path: 'TOY_TEST_FAIL', data: 'the tests fail at this commit\n' });
  if (options.probes !== undefined) files.push({ path: 'probes.json', data: JSON.stringify(options.probes) });
  return tarGz(`${repo.replace('/', '-')}-${sha.slice(0, 7)}`, files).toString('base64');
}

/** Fake GitHub state: `shas` in order on `main` of `repo` (no workflow runs), with their tarballs. */
export function buildMainState(repo: string, shas: string[], tarballs: Record<string, string>): unknown {
  return {
    repos: {
      [repo]: {
        branches: { main: shas.map((sha, i) => ({ sha, parent: i === 0 ? null : (shas[i - 1] ?? null) })) },
        tarballs,
      },
    },
  };
}

// ── BuildKit inside dind ───────────────────────────────────────────────────────────────────────

export interface SolveCall {
  target: string;
  push: string | null;
  at: number;
}

export interface DindBuildKit {
  /** buildkitd's container name inside dind. */
  container: string;
  /** The real adapter, `buildctl` exec'd inside that container. */
  buildkit: BuildKitPort;
  /** Wraps a port so each solve is recorded, in order, before it runs. */
  spy(port?: BuildKitPort): { buildkit: BuildKitPort; calls: SolveCall[] };
  /** A directory under `sharedDir` (so buildkitd sees it at the same path), mode 0777. */
  workDir: string;
  /** The `registry.shipyard.test` address buildkitd pushes to. */
  registryAddr: string;
  /** dind's container ID on the outer daemon. */
  dindId: string;
  stop(): Promise<void>;
}

/**
 * Makes `image` present in dind: loaded from the outer daemon when it already holds it (CI pulls it
 * there first, once), otherwise pulled by dind itself.
 */
export async function seedDind(h: Harness, image: string): Promise<void> {
  const local = await runRaw('docker', ['image', 'inspect', '--format', '{{.Id}}', image]);
  if (local.code === 0) {
    try {
      await pipe(['save', image], process.env, ['load', '--quiet'], h.dindEnv());
      return;
    } catch {
      // A multi-platform store may refuse to save; dind pulls it instead.
    }
  }
  await h.dind(['pull', '--quiet', image]);
}

export async function startBuildKit(h: Harness): Promise<DindBuildKit> {
  const id = randomBytes(3).toString('hex');
  const outer = (args: string[]) => run('docker', args, { timeoutMs: 240_000 });
  const serviceId = async (service: string): Promise<string> => {
    const out = (await outer(['compose', '-f', HARNESS_COMPOSE, '-p', h.project, 'ps', '-q', service])).stdout.trim();
    if (out === '') throw new Error(`${service} container not found`);
    return out;
  };
  const dindId = await serviceId('dind');
  const aliasId = await serviceId('registry-alias');
  const container = `shp-bk-${id}`;
  const net = `shp-e2e-public-${id}`;
  let netMade = false;

  const stop = async (): Promise<void> => {
    await runRaw('docker', ['rm', '-f', container], { env: h.dindEnv() });
    if (netMade) {
      await runRaw('docker', ['network', 'disconnect', '-f', net, dindId]);
      await runRaw('docker', ['network', 'disconnect', '-f', net, aliasId]);
      await runRaw('docker', ['network', 'rm', net]);
    }
  };

  try {
    // The build network and its firewall, by the operator script, inside dind.
    const script = join(h.sharedDir, 'build-network.sh');
    await copyFile(join(INSTALL_DIR, 'build-network.sh'), script);
    await outer(['exec', dindId, 'sh', script]);

    // The registry on a public-looking address (see the header).
    const prefix = `198.18.${String(randomInt(10, 250))}`;
    const registryAddr = `${prefix}.10`;
    await outer(['network', 'create', '--subnet', `${prefix}.0/24`, net]);
    netMade = true;
    await outer(['network', 'connect', '--ip', registryAddr, net, aliasId]);
    await outer(['network', 'connect', net, dindId]);

    const workDir = join(h.sharedDir, `build-${id}`);
    await mkdir(workDir, { recursive: true });
    await chmod(workDir, 0o777);
    const config = join(workDir, 'buildkitd.toml');
    await writeFile(config, [`[registry."${MANIFEST_REGISTRY}"]`, '  http = true', '  insecure = true', ''].join('\n'));
    await chmod(config, 0o644);

    const image = await buildkitImage();
    await seedDind(h, image);
    await h.dind([
      'run', '-d', '--name', container, '--network', BUILD_NETWORK_NAME,
      '--security-opt', 'seccomp=unconfined',
      '--add-host', `${MANIFEST_REGISTRY}:${registryAddr}`,
      '-v', `${h.sharedDir}:${h.sharedDir}`,
      image, '--oci-worker-no-process-sandbox', '--addr', BUILDKIT_SOCK, '--config', config,
    ]);
    await pollUntil(
      'buildkitd',
      async () => (await runRaw('docker', ['exec', container, 'buildctl', '--addr', BUILDKIT_SOCK, 'debug', 'workers'], { env: h.dindEnv() })).code === 0,
      { timeoutMs: 60_000 },
    );

    const buildkit = createBuildKitAdapter({
      addr: BUILDKIT_SOCK,
      tmpDir: workDir,
      // The adapter's argv, run inside the buildkitd container. Its env (DOCKER_CONFIG and the like)
      // is for a local buildctl; here the docker CLI needs dind's.
      execFile: (file, args, options) =>
        runArgv('docker', ['exec', '-u', '0', container, file, ...args], {
          env: h.dindEnv(),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        }),
    });

    const spy = (port: BuildKitPort = buildkit): { buildkit: BuildKitPort; calls: SolveCall[] } => {
      const calls: SolveCall[] = [];
      return {
        calls,
        buildkit: {
          ...port,
          solve(req: SolveRequest, onLog, signal) {
            calls.push({ target: req.target, push: req.push?.ref ?? null, at: Date.now() });
            return port.solve(req, onLog, signal);
          },
        },
      };
    };

    return { container, buildkit, spy, workDir, registryAddr, dindId, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

// ── the registry, read over HTTP from the host ─────────────────────────────────────────────────

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/** The tags a repository holds (empty when the repository does not exist). */
export async function registryTags(registryHostPort: number, repository: string): Promise<string[]> {
  const res = await fetch(`http://127.0.0.1:${String(registryHostPort)}/v2/${repository}/tags/list`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`tags/list for ${repository}: HTTP ${String(res.status)}`);
  return ((await res.json()) as { tags: string[] | null }).tags ?? [];
}

export interface PushedImage {
  /** Docker-Content-Digest of the tag's manifest. */
  digest: string;
  mediaType: string;
  labels: Record<string, string>;
}

/** The manifest digest and the image config's labels of `repository:tag` (first manifest of an index). */
export async function pushedImage(registryHostPort: number, repository: string, tag: string): Promise<PushedImage> {
  const base = `http://127.0.0.1:${String(registryHostPort)}/v2/${repository}`;
  const res = await fetch(`${base}/manifests/${tag}`, { headers: { accept: MANIFEST_ACCEPT } });
  if (!res.ok) throw new Error(`${repository}:${tag}: HTTP ${String(res.status)}`);
  const digest = res.headers.get('docker-content-digest') ?? '';
  let manifest = (await res.json()) as { mediaType?: string; manifests?: { digest: string }[]; config?: { digest: string } };
  const mediaType = manifest.mediaType ?? '';
  if (manifest.manifests !== undefined) {
    const first = manifest.manifests[0];
    if (first === undefined) throw new Error(`${repository}:${tag}: empty index`);
    const inner = await fetch(`${base}/manifests/${first.digest}`, { headers: { accept: MANIFEST_ACCEPT } });
    manifest = (await inner.json()) as typeof manifest;
  }
  const configDigest = manifest.config?.digest;
  if (configDigest === undefined) throw new Error(`${repository}:${tag}: no config`);
  const config = (await (await fetch(`${base}/blobs/${configDigest}`)).json()) as { config?: { Labels?: Record<string, string> | null } };
  return { digest, mediaType, labels: config.config?.Labels ?? {} };
}
