import { randomBytes, randomInt } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Manifest } from '@shipyard/schema';
import {
  BUILD_NETWORK_GATEWAY,
  BUILD_NETWORK_NAME,
  createDockerAdapter,
  createIntegrationStage,
  INTEGRATION_BRIDGE_PREFIX,
  INTEGRATION_GATEWAY_MODE_OPTION,
  INTEGRATION_SUBNET_POOL,
  integrationProjectName,
  verifyBuildNetwork,
  type BuildNetworkInfo,
  type IntegrationDocker,
  type TestImageBuilder,
} from '@shipyard/sequence';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { runRaw, run, pollUntil } from '../harness/exec.js';
import { HARNESS_COMPOSE, startHarness, type Harness } from '../harness/harness.js';

/**
 * SHP-T-7.8 in Docker-in-Docker: the build network and the integration stage.
 *
 * The world inside dind, and the substitutions it makes:
 *
 * - **The operator script runs for real**: `docs/install/build-network.sh` is copied into the shared
 *   directory and executed inside the dind container (which has docker + iptables), twice, to prove
 *   it is idempotent. dind is the "Docker host".
 * - **A LAN and the internet, from dind's point of view.** Three networks are created on the OUTER
 *   daemon — a random `10.x.y.0/24`, a random `192.168.x.0/24`, and a random `198.18.x.0/24`
 *   non-RFC1918 "public" subnet (the benchmarking range) — and connected to the dind container. One
 *   busybox httpd stand-in sits on all three. From a container inside dind, those addresses are
 *   reached exactly like a LAN host or an internet host from a real Docker host: forwarded out of
 *   dind's own interfaces and masqueraded. So the "public host" is a stand-in on a non-RFC1918
 *   address (the harness makes no promise of internet access); the 10.x and 192.168.x hosts are
 *   real listeners, not just unrouted addresses.
 * - **A control container** on an ordinary dind network reaches every one of those listeners (and its
 *   own gateway's dockerd on :2375, and the other project's Postgres from that project's network),
 *   so a failure from `shipyard-build` is the firewall, not a missing listener.
 * - **A real BuildKit RUN step**: rootless buildkitd (the image `docs/install/buildkit.compose.yml`
 *   pins) runs inside dind attached only to `shipyard-build`; a RUN step probes every target. Its
 *   `FROM busybox` is pulled by buildkitd through the same network, which needs real internet from
 *   the machine running the tests.
 * - **The integration stage** runs through the real engine code (`createIntegrationStage`) and the
 *   real Docker adapter aimed at dind. Only the test-image export differs from production: the
 *   BuildKit port cannot yet export a docker tar (see SHP-T-7.8's needsOutside), so this test's
 *   builder runs `docker build` in dind, `docker save`s the tar and removes the image again, so the
 *   stage's `docker load` is genuine.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const INSTALL_DIR = resolve(HERE, '../../docs/install');
const BUSYBOX = 'busybox:1.37';
const POSTGRES = 'postgres:16-alpine';
const SHA = 'a'.repeat(40);
const BLOCKED_RE = /timed out|unreachable|no route to host/i;

interface Probe {
  exit: number;
  output: string;
}

function parseProbe(text: string): Probe {
  const match = /exit=(\d+)/.exec(text);
  return { exit: match === null ? -1 : Number(match[1]), output: text.trim() };
}

const reached = (p: Probe): boolean => p.exit === 0;
/** A TCP listener that is not HTTP (Postgres) answers, so wget fails — but not by timing out. */
const answered = (p: Probe): boolean => !BLOCKED_RE.test(p.output);
const blocked = (p: Probe): boolean => p.exit !== 0 && BLOCKED_RE.test(p.output);

describe('build network isolation and the integration stage (SHP-T-7.8)', () => {
  let h: Harness;
  let dindId = '';
  const id = randomBytes(3).toString('hex');
  const outerNets: string[] = [];
  const standIn = `shp-e2e-standin-${id}`;
  const otherProject = `shp-other-${id}`;
  let otherDir = '';
  const addr = { public: '', lan10: '', lan192: '' };
  let pgIp = '';
  let controlGateway = '';
  /** Every IPv4 address dind (the "Docker host") owns, loopback aside. */
  let hostAddrs: string[] = [];
  const outer = (args: string[]) => run('docker', args, { timeoutMs: 240_000 });

  beforeAll(async () => {
    h = await startHarness();
    dindId = (await run('docker', ['compose', '-f', HARNESS_COMPOSE, '-p', h.project, 'ps', '-q', 'dind'])).stdout.trim();
    if (dindId === '') throw new Error('dind container not found');

    // ── the stand-in LAN and "internet", on the outer daemon, connected to dind ──
    const a = randomInt(10, 250);
    const b = randomInt(10, 250);
    const subnets = {
      lan10: `10.${String(a)}.${String(b)}`,
      lan192: `192.168.${String(b)}`,
      // 198.18.0.0/15 (benchmarking): not RFC1918, not in the blocked list, never a real LAN.
      public: `198.18.${String(b)}`,
    };
    await outer(['pull', '--quiet', BUSYBOX]);
    for (const [key, prefix] of Object.entries(subnets)) {
      const name = `shp-e2e-${key}-${id}`;
      await outer(['network', 'create', '--subnet', `${prefix}.0/24`, name]);
      outerNets.push(name);
      addr[key as keyof typeof addr] = `${prefix}.10`;
    }
    const [firstNet, ...restNets] = outerNets;
    await outer([
      'run', '-d', '--name', standIn, '--network', firstNet ?? '', '--ip', addr.lan10, BUSYBOX,
      'sh', '-c', 'mkdir -p /www && echo standin-ok > /www/index.html && exec httpd -f -p 8080 -h /www',
    ]);
    const ips = [addr.lan192, addr.public];
    for (const [i, net] of restNets.entries()) await outer(['network', 'connect', '--ip', ips[i] ?? '', net, standIn]);
    for (const net of outerNets) await outer(['network', 'connect', net, dindId]);

    // ── the operator script, twice (idempotent) ──
    const script = join(h.sharedDir, 'build-network.sh');
    await copyFile(join(INSTALL_DIR, 'build-network.sh'), script);
    await outer(['exec', dindId, 'sh', script]);
    await outer(['exec', dindId, 'sh', script]);

    // ── images and the other compose project's Postgres, inside dind ──
    await h.dind(['pull', '--quiet', BUSYBOX]);
    await h.dind(['pull', '--quiet', POSTGRES]);
    otherDir = await mkdtemp(join(tmpdir(), `${otherProject}-`));
    await writeFile(
      join(otherDir, 'compose.yml'),
      [
        'services:',
        '  db:',
        `    image: ${POSTGRES}`,
        '    environment: { POSTGRES_PASSWORD: pw }',
        '    healthcheck: { test: ["CMD", "pg_isready", "-U", "postgres"], interval: 1s, retries: 60 }',
        '',
      ].join('\n'),
    );
    await h.dind(['compose', '-f', join(otherDir, 'compose.yml'), '-p', otherProject, 'up', '-d', '--wait']);
    const pgId = (await h.dind(['compose', '-f', join(otherDir, 'compose.yml'), '-p', otherProject, 'ps', '-q', 'db'])).stdout.trim();
    pgIp = (await h.dind(['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', pgId])).stdout.trim();

    // ── the control network: ordinary, not shipyard-build ──
    await h.dind(['network', 'create', `shp-control-${id}`]);
    controlGateway = (await h.dind(['network', 'inspect', '-f', '{{range .IPAM.Config}}{{.Gateway}}{{end}}', `shp-control-${id}`])).stdout.trim();
    hostAddrs = await dindAddrs();
    expect(hostAddrs).toContain(controlGateway);
  });

  /** dind's own IPv4 addresses (every interface, loopback aside), from inside dind. */
  const dindAddrs = async (): Promise<string[]> => {
    const out = (await outer(['exec', dindId, 'ip', '-4', '-o', 'addr', 'show'])).stdout;
    return [...out.matchAll(/inet (\d+\.\d+\.\d+\.\d+)\//g)].map((m) => m[1] ?? '').filter((a) => a !== '' && !a.startsWith('127.'));
  };

  afterAll(async () => {
    await runRaw('docker', ['rm', '-f', standIn]);
    for (const net of outerNets) {
      await runRaw('docker', ['network', 'disconnect', '-f', net, dindId]);
      await runRaw('docker', ['network', 'rm', net]);
    }
    if (otherDir !== '') await rm(otherDir, { recursive: true, force: true });
    await h.stop();
  });

  /** busybox wget from a fresh container on `network`; always exits 0 and reports wget's own exit. */
  const probe = async (network: string, url: string): Promise<Probe> => {
    const r = await h.dind(['run', '--rm', '--network', network, BUSYBOX, 'sh', '-c', 'out=$(wget -q -T 5 -O /dev/null "$0" 2>&1); echo "exit=$? $out"', url]);
    return parseProbe(r.stdout);
  };

  it('the script makes the network the agent preflight expects, with one copy of each rule', async () => {
    const inspector = {
      async inspectNetwork(name: string): Promise<BuildNetworkInfo | null> {
        const r = await runRaw('docker', ['network', 'inspect', name], { env: h.dindEnv() });
        if (r.code !== 0) return null;
        const [n] = JSON.parse(r.stdout) as { Name: string; Internal: boolean; EnableIPv6: boolean; Options: Record<string, string> | null; IPAM: { Config: { Subnet: string }[] | null } }[];
        if (n === undefined) return null;
        return { name: n.Name, internal: n.Internal, enableIPv6: n.EnableIPv6, options: n.Options ?? {}, subnets: (n.IPAM.Config ?? []).map((c) => c.Subnet) };
      },
    };
    await expect(verifyBuildNetwork(inspector)).resolves.toMatchObject({ name: BUILD_NETWORK_NAME });
    const rules = (await outer(['exec', dindId, 'iptables', '-S', 'DOCKER-USER'])).stdout;
    expect(rules.split('\n').filter((l) => l.includes('SHIPYARD-BUILD')).length).toBe(1);
    const input = (await outer(['exec', dindId, 'iptables', '-S', 'INPUT'])).stdout;
    expect(input.split('\n').filter((l) => l.includes('SHIPYARD-BUILD-INPUT')).length).toBe(1);
    // The per-build integration pool: one jump per match, in INPUT and in DOCKER-USER.
    const count = (text: string, needle: string): number => text.split('\n').filter((l) => l.includes(needle)).length;
    expect(count(input, `-s ${INTEGRATION_SUBNET_POOL} -j SHIPYARD-ITEST-INPUT`)).toBe(1);
    expect(count(input, `-i ${INTEGRATION_BRIDGE_PREFIX}+ -j SHIPYARD-ITEST-INPUT`)).toBe(1);
    expect(count(rules, `-s ${INTEGRATION_SUBNET_POOL} -j SHIPYARD-ITEST`)).toBe(1);
    expect(count(rules, `-i ${INTEGRATION_BRIDGE_PREFIX}+ -j SHIPYARD-ITEST`)).toBe(1);
  });

  it('the firewall alone keeps an internal network in the pool off the host, even when the host owns its gateway — which an internal network outside the pool does not', async () => {
    // What the integration stage's gateway mode `isolated` removes, recreated on purpose: an
    // internal network whose gateway address the host (dind) owns, so traffic to it takes INPUT.
    const inPool = `shp-fallback-pool-${id}`;
    const outside = `shp-fallback-out-${id}`;
    const slot = randomInt(200, 250);
    try {
      await h.dind(['network', 'create', '--internal', '--subnet', `172.30.${String(slot)}.0/24`, '--gateway', `172.30.${String(slot)}.1`, '-o', `com.docker.network.bridge.name=${INTEGRATION_BRIDGE_PREFIX}${String(slot)}`, inPool]);
      await h.dind(['network', 'create', '--internal', '--subnet', `172.29.${String(slot)}.0/24`, '--gateway', `172.29.${String(slot)}.1`, outside]);
      const control = await probe(outside, `http://172.29.${String(slot)}.1:2375/_ping`);
      expect(reached(control), `the gap this closes: ${control.output}`).toBe(true);
      for (const url of [`http://172.30.${String(slot)}.1:2375/_ping`, `http://${controlGateway}:2375/_ping`]) {
        const p = await probe(inPool, url);
        expect(p.exit, `${url}: ${p.output}`).not.toBe(0);
      }
      const gw = await probe(inPool, `http://172.30.${String(slot)}.1:2375/_ping`);
      expect(blocked(gw), gw.output).toBe(true);
    } finally {
      await runRaw('docker', ['network', 'rm', inPool, outside], { env: h.dindEnv() });
    }
  });

  it('a container on shipyard-build reaches the public stand-in, and not the host, 10.x, 192.168.x or another project’s Postgres — which a control container does reach', async () => {
    const control = `shp-control-${id}`;
    const pgNet = `${otherProject}_default`;
    const targets = {
      public: `http://${addr.public}:8080/`,
      lan10: `http://${addr.lan10}:8080/`,
      lan192: `http://${addr.lan192}:8080/`,
    };

    // Controls: every listener is live and routable from an ordinary dind network.
    expect(reached(await probe(control, targets.public))).toBe(true);
    expect(reached(await probe(control, targets.lan10))).toBe(true);
    expect(reached(await probe(control, targets.lan192))).toBe(true);
    expect(reached(await probe(control, `http://${controlGateway}:2375/_ping`))).toBe(true);
    expect(answered(await probe(pgNet, `http://${pgIp}:5432/`))).toBe(true);

    // The build network.
    const pub = await probe(BUILD_NETWORK_NAME, targets.public);
    expect(reached(pub), pub.output).toBe(true);
    for (const url of [
      `http://${BUILD_NETWORK_GATEWAY}:2375/_ping`,
      `http://${controlGateway}:2375/_ping`,
      targets.lan10,
      targets.lan192,
      `http://${pgIp}:5432/`,
    ]) {
      const p = await probe(BUILD_NETWORK_NAME, url);
      expect(blocked(p), `${url}: ${p.output}`).toBe(true);
    }
  });

  it('a BuildKit RUN step in rootless buildkitd on shipyard-build sees the same', async () => {
    const compose = parse(await readFile(join(INSTALL_DIR, 'buildkit.compose.yml'), 'utf8')) as { services: { buildkitd: { image: string } } };
    const image = compose.services.buildkitd.image;
    const bk = `shp-bk-${id}`;
    const sock = 'unix:///run/user/1000/buildkit/buildkitd.sock';
    await h.dind(['pull', '--quiet', image]);
    await h.dind([
      'run', '-d', '--name', bk, '--network', BUILD_NETWORK_NAME, '--security-opt', 'seccomp=unconfined',
      image, '--oci-worker-no-process-sandbox', '--addr', sock,
    ]);
    try {
      await pollUntil('buildkitd', async () => (await runRaw('docker', ['exec', bk, 'buildctl', '--addr', sock, 'debug', 'workers'], { env: h.dindEnv() })).code === 0, { timeoutMs: 60_000 });
      const ctx = await mkdtemp(join(tmpdir(), 'shp-bk-ctx-'));
      try {
        await writeFile(
          join(ctx, 'Dockerfile'),
          [
            `FROM ${BUSYBOX}`,
            'ARG TARGETS',
            'RUN for t in $TARGETS; do out=$(wget -q -T 5 -O /dev/null "$t" 2>&1); echo "PROBE $t exit=$? $out"; done',
            '',
          ].join('\n'),
        );
        await h.dind(['exec', bk, 'mkdir', '-p', '/tmp/ctx']);
        await h.dind(['cp', join(ctx, 'Dockerfile'), `${bk}:/tmp/ctx/Dockerfile`]);
      } finally {
        await rm(ctx, { recursive: true, force: true });
      }
      const pub = `http://${addr.public}:8080/`;
      const denied = [
        `http://${BUILD_NETWORK_GATEWAY}:2375/_ping`,
        `http://${addr.lan10}:8080/`,
        `http://${addr.lan192}:8080/`,
        `http://${pgIp}:5432/`,
      ];
      const r = await h.dind([
        'exec', bk, 'buildctl', '--addr', sock, 'build', '--progress', 'plain', '--no-cache',
        '--frontend', 'dockerfile.v0', '--local', 'context=/tmp/ctx', '--local', 'dockerfile=/tmp/ctx',
        '--opt', `build-arg:TARGETS=${[pub, ...denied].join(' ')}`,
      ]);
      const text = `${r.stdout}\n${r.stderr}`;
      const lines = new Map<string, Probe>();
      for (const m of text.matchAll(/PROBE (\S+) (exit=\d+.*)$/gm)) lines.set(m[1] ?? '', parseProbe(m[2] ?? ''));
      expect(reached(lines.get(pub) ?? parseProbe('')), text).toBe(true);
      for (const url of denied) expect(blocked(lines.get(url) ?? parseProbe('')), `${url}\n${text}`).toBe(true);
    } finally {
      await runRaw('docker', ['rm', '-f', bk], { env: h.dindEnv() });
    }
  });

  // ── the integration stage ──────────────────────────────────────────────────────────────────

  /** A source tree whose test target runs itest.sh: sidecar reachable, no route out, then exit $1. */
  const sourceTree = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'shp-itest-src-'));
    await mkdir(join(dir, 'ci'));
    await writeFile(join(dir, 'Dockerfile'), [`FROM ${BUSYBOX} AS test`, 'COPY itest.sh /itest.sh', 'CMD ["sh", "/itest.sh", "0"]', ''].join('\n'));
    await writeFile(
      join(dir, 'itest.sh'),
      [
        'set -u',
        'for i in $(seq 1 30); do wget -q -T 2 -O - http://sidecar:8080/ && break; sleep 1; done | grep -q sidecar-ok || { echo "sidecar unreachable"; exit 98; }',
        'if ip -4 route | grep -q "^default"; then echo "a default route exists"; ip -4 route; exit 97; fi',
        `if wget -q -T 3 -O /dev/null http://${addr.public}:8080/; then echo "public reachable from the internal network"; exit 99; fi`,
        // The host through this network's own first address (where Docker would put the gateway),
        // and through every address the host owns: its other bridges' gateways, its own interfaces.
        'gw=$(ip -4 route | awk \'/src/ { split($1, a, "/"); split(a[1], o, "."); print o[1] "." o[2] "." o[3] "." (o[4] + 1); exit }\')',
        `for h in "$gw" ${[...new Set([...hostAddrs, BUILD_NETWORK_GATEWAY, controlGateway])].join(' ')}; do`,
        '  if wget -q -T 3 -O /dev/null "http://$h:2375/_ping"; then echo "docker host reachable at $h"; exit 99; fi',
        '  echo "host $h:2375 unreachable"',
        'done',
        'echo "isolation holds; exiting $1"',
        'exit "$1"',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(dir, 'ci', 'integration.yml'),
      [
        'services:',
        '  itest:',
        '    build: { context: .., target: test }',
        '    depends_on: [sidecar]',
        '  sidecar:',
        `    image: ${BUSYBOX}`,
        '    command: ["sh", "-c", "mkdir -p /www && echo sidecar-ok > /www/index.html && exec httpd -f -p 8080 -h /www"]',
        '    volumes:',
        '      - sidecar-data:/data',
        '      - /anon',
        'volumes:',
        '  sidecar-data: {}',
        '',
      ].join('\n'),
    );
    return dir;
  };

  const manifestFor = (argv: string[]): Manifest =>
    Manifest.parse({
      name: 'itoy',
      repo: 'matdemers1/itoy',
      workflow: 'ci.yml',
      compose: { files: ['/data/itoy/compose.yml'], project: 'itoy' },
      services: { app: { image: 'registry.shipyard.test/itoy/app' } },
      health: { service: 'app', port: 3000, path: '/health' },
      build: { source: 'shipyard', releaseTargets: { app: 'release' }, integration: { compose: 'ci/integration.yml', service: 'itest', argv } },
    });

  const docker = (): IntegrationDocker => {
    const port = createDockerAdapter({ dockerHost: h.dockerHost });
    return {
      compose: port.compose.bind(port),
      removeImage: port.removeImage.bind(port),
      async loadImage(tar) {
        const r = await runRaw('docker', ['load', '-i', tar], { env: h.dindEnv() });
        return { exitCode: r.code ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
    };
  };

  /** Stand-in for the BuildKit docker-tar export: build in dind, save the tar, drop dind's copy. */
  const builder: TestImageBuilder = {
    async solveToDockerTar(req, out) {
      const env = h.dindEnv();
      const built = await runRaw('docker', ['build', '--quiet', '-f', req.dockerfile, '--target', req.target, '-t', out.name, req.contextDir], { env, timeoutMs: 300_000 });
      if (built.code !== 0) return { exitCode: built.code ?? 1 };
      const saved = await runRaw('docker', ['save', '-o', out.dest, out.name], { env });
      await runRaw('docker', ['image', 'rm', out.name], { env });
      return { exitCode: saved.code ?? 1 };
    },
  };

  const leftovers = async (buildId: string): Promise<string[]> => {
    const project = integrationProjectName(buildId);
    const names = async (args: string[]): Promise<string[]> => (await h.dind(args)).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    return [
      ...(await names(['ps', '-a', '--format', '{{.Names}}'])).filter((n) => n.startsWith('shipyard-build-')).map((n) => `container ${n}`),
      ...(await names(['ps', '-a', '-q', '--filter', `label=com.docker.compose.project=${project}`])).map((n) => `container ${n}`),
      ...(await names(['network', 'ls', '--format', '{{.Name}}'])).filter((n) => n.startsWith('shipyard-build-')).map((n) => `network ${n}`),
      ...(await names(['volume', 'ls', '--format', '{{.Name}}'])).filter((n) => n.startsWith('shipyard-build-')).map((n) => `volume ${n}`),
      ...(await names(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'])).filter((n) => n.startsWith('shipyard-build/')).map((n) => `image ${n}`),
    ];
  };
  const volumes = async (): Promise<string[]> => (await h.dind(['volume', 'ls', '-q'])).stdout.split('\n').filter(Boolean).sort();

  const runStage = async (argv: string[], signal?: AbortSignal, buildId = `b${randomBytes(4).toString('hex')}`): Promise<{ passed: boolean; log: string; buildId: string; newVolumes: string[] }> => {
    const dir = await sourceTree();
    const work = await mkdtemp(join(tmpdir(), 'shp-itest-work-'));
    const before = await volumes();
    const chunks: string[] = [];
    try {
      const hook = createIntegrationStage({
        docker: docker(),
        buildkit: builder,
        dir,
        manifest: manifestFor(argv),
        buildId,
        sha: SHA,
        tmpDir: work,
        timeoutMs: 120_000,
        ...(signal === undefined ? {} : { signal }),
      });
      const passed = await hook({ onLog: (c) => chunks.push(c) });
      const after = await volumes();
      return { passed, log: chunks.join(''), buildId, newVolumes: after.filter((v) => !before.includes(v)) };
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  };

  it('passes on exit 0 — sidecar reached, no route out — and leaves nothing behind', async () => {
    const r = await runStage(['sh', '/itest.sh', '0']);
    expect(r.passed, r.log).toBe(true);
    expect(r.log).toContain('isolation holds; exiting 0');
    for (const a of [BUILD_NETWORK_GATEWAY, controlGateway, ...hostAddrs]) expect(r.log).toContain(`host ${a}:2375 unreachable`);
    expect(await leftovers(r.buildId)).toEqual([]);
    expect(r.newVolumes).toEqual([]);
  });

  it('fails on a non-zero exit and leaves nothing behind', async () => {
    const r = await runStage(['sh', '/itest.sh', '3']);
    expect(r.passed, r.log).toBe(false);
    expect(r.log).toContain('isolation holds; exiting 3');
    expect(r.log).toContain('itest exited 3');
    expect(await leftovers(r.buildId)).toEqual([]);
    expect(r.newVolumes).toEqual([]);
  });

  it('cancelled mid-run, resolves false and leaves nothing behind — and while it ran, the host had no address on its network', async () => {
    const controller = new AbortController();
    const buildId = `b${randomBytes(4).toString('hex')}`;
    const running = runStage(['sleep', '300'], controller.signal, buildId);
    // Cancel once the one-off test container is actually running.
    await pollUntil(
      'the integration run container',
      async () => {
        const r = await runRaw('docker', ['ps', '-q', '--filter', 'label=com.docker.compose.oneoff=True', '--filter', 'label=com.docker.compose.service=itest'], { env: h.dindEnv() });
        return r.code === 0 && r.stdout.trim() !== '';
      },
      { timeoutMs: 180_000 },
    );
    try {
      const net = JSON.parse((await h.dind(['network', 'inspect', `${integrationProjectName(buildId)}_default`])).stdout) as {
        Internal: boolean;
        EnableIPv6: boolean;
        Options: Record<string, string>;
        IPAM: { Config: { Subnet: string; Gateway?: string }[] };
      }[];
      const info = net[0];
      expect(info?.Internal).toBe(true);
      expect(info?.EnableIPv6).toBe(false);
      expect(info?.Options[INTEGRATION_GATEWAY_MODE_OPTION]).toBe('isolated');
      expect(info?.Options['com.docker.network.bridge.name']).toMatch(new RegExp(`^${INTEGRATION_BRIDGE_PREFIX}\\d+$`));
      const subnet = info?.IPAM.Config[0]?.Subnet ?? '';
      expect(subnet).toMatch(/^172\.30\.\d+\.0\/24$/);
      const prefix = subnet.split('.').slice(0, 3).join('.');
      expect((await dindAddrs()).filter((a) => a.startsWith(`${prefix}.`))).toEqual([]);
    } finally {
      controller.abort();
    }
    const r = await running;
    expect(r.passed).toBe(false);
    expect(r.log).toContain('cancelled');
    expect(await leftovers(r.buildId)).toEqual([]);
    expect(r.newVolumes).toEqual([]);
  });
});
