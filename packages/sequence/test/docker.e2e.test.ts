import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Dockerode from 'dockerode';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDockerAdapter } from '../src/adapters/docker.js';
import type { ComposeTarget, DockerPort } from '../src/ports.js';

/**
 * Real Docker (SHP-T-1.6). Skipped unless SHIPYARD_DOCKER_E2E=1. Uses the daemon the `docker` CLI
 * and dockerode reach by default (DOCKER_HOST or /var/run/docker.sock), a uniquely named project
 * `shp-t16-<id>`, no published ports, and tears everything down.
 */
const enabled = process.env.SHIPYARD_DOCKER_E2E === '1';

const COMPOSE = `services:
  web:
    image: busybox:1.37
    command:
      - sh
      - -c
      - 'mkdir -p /www && printf "{\\"status\\":\\"ok\\",\\"schema\\":\\"e2e\\"}" > /www/health && exec httpd -f -p 3000 -h /www'
`;

describe.skipIf(!enabled)('docker adapter against a real daemon', () => {
  const project = `shp-t16-${randomBytes(4).toString('hex')}`;
  const docker = new Dockerode();
  let dir = '';
  let target: ComposeTarget;
  let adapter: DockerPort;

  const networkMembers = async (): Promise<string[]> => {
    const info = (await docker.getNetwork(`${project}_default`).inspect()) as { Containers?: Record<string, unknown> };
    return Object.keys(info.Containers ?? {}).sort();
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), `${project}-`));
    const file = join(dir, 'compose.yml');
    await writeFile(file, COMPOSE, 'utf8');
    target = { files: [file], project };
    adapter = createDockerAdapter({ docker });
    const up = await adapter.compose(target, ['up', '-d', '--wait', '--quiet-pull'], { timeoutMs: 120_000 });
    expect(up.exitCode, up.stderr).toBe(0);
  }, 180_000);

  afterAll(async () => {
    if (dir === '') return;
    await adapter.compose(target, ['down', '-v', '--remove-orphans', '--timeout', '2'], { timeoutMs: 60_000 });
    await rm(dir, { recursive: true, force: true });
  }, 90_000);

  it('lists the service container with its network and image digests', async () => {
    const list = await adapter.containers(target, 'web');
    expect(list).toHaveLength(1);
    expect(list[0]?.service).toBe('web');
    expect(list[0]?.state).toBe('running');
    expect(list[0]?.networks).toEqual([`${project}_default`]);
    expect(list[0]?.repoDigests.some((d) => d.startsWith('busybox@sha256:'))).toBe(true);
  });

  it('probes /health over the app network and leaves the network as it found it', async () => {
    const before = await networkMembers();
    let res: Awaited<ReturnType<DockerPort['probeHealth']>> | undefined;
    // httpd may need a moment after `up --wait`; poll rather than sleep.
    for (let i = 0; i < 10 && res?.httpStatus !== 200; i++) {
      res = await adapter.probeHealth(target, 'web', 3000, '/health', 3000).catch(() => undefined);
    }
    expect(res).toEqual({ httpStatus: 200, body: { status: 'ok', schema: 'e2e' } });
    expect(await networkMembers()).toEqual(before);

    // A 404 and a refused connection leave nothing behind either.
    await expect(adapter.probeHealth(target, 'web', 3000, '/nope', 3000)).resolves.toMatchObject({ httpStatus: 404 });
    expect(await networkMembers()).toEqual(before);
    await expect(adapter.probeHealth(target, 'web', 3001, '/health', 3000)).rejects.toThrow(/no HTTP response/);
    expect(await networkMembers()).toEqual(before);
  }, 120_000);

  it('reports free bytes on the Docker root', async () => {
    expect(await adapter.freeBytes()).toBeGreaterThan(0);
  }, 60_000);

  it('a failing compose command returns its exit code instead of throwing', async () => {
    const r = await adapter.compose(target, ['exec', '-T', 'no-such-service', 'true']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/no-such-service|not running|no such service/i);
  });
});
