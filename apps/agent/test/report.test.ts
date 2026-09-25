import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentReport } from '@shipyard/schema';
import { Ledger, type ComposeTarget, type DockerPort, type FsPort, type LedgerEntry, type RunningContainer } from '@shipyard/sequence';
import type { AgentClient } from '../src/client.js';
import { buildReport, manifestsHash, reportHash, startReporting } from '../src/report.js';

const ROOT = '/data/shipyard';
const DIGEST_WEB = `sha256:${'a'.repeat(64)}`;
const DIGEST_OTHER = `sha256:${'c'.repeat(64)}`;

function manifestYaml(name: string, soak = 60): string {
  return [
    `name: ${name}`,
    `repo: matdemers1/${name}`,
    'workflow: ci.yml',
    'compose:',
    `  files: [/srv/${name}/compose.yml]`,
    `  project: ${name}`,
    'services:',
    `  web: { image: ghcr.io/matdemers1/${name} }`,
    `  worker: { image: ghcr.io/matdemers1/${name}-worker }`,
    'health: { service: web, port: 8080, path: /health }',
    `soakSeconds: ${soak}`,
    '',
  ].join('\n');
}

function fakeFs(files: Map<string, string>): FsPort {
  return {
    readFile: (path) => {
      const text = files.get(path);
      return text === undefined ? Promise.reject(new Error(`ENOENT ${path}`)) : Promise.resolve(text);
    },
    writeFileAtomic: () => Promise.reject(new Error('read-only')),
    appendLine: () => Promise.reject(new Error('read-only')),
    exists: (path) => Promise.resolve(path === `${ROOT}/apps`),
    mkdirp: () => Promise.resolve(),
    list: (dir) =>
      Promise.resolve([...files.keys()].filter((p) => p.startsWith(`${dir}/`)).map((path) => ({ path, size: 1, mtimeMs: 0 }))),
  };
}

function container(service: string, state: string, repoDigests: string[]): RunningContainer {
  return { id: `${service}-1`, service, repoDigests, labels: {}, state, networks: [] };
}

function fakeDocker(byService: Record<string, RunningContainer[]>): DockerPort & { composeCalls: { target: ComposeTarget; args: string[] }[] } {
  const composeCalls: { target: ComposeTarget; args: string[] }[] = [];
  return {
    composeCalls,
    compose: (target, args) => {
      composeCalls.push({ target, args });
      return Promise.resolve({ exitCode: 0, stdout: '5.0.1\n', stderr: '' });
    },
    containers: (target, service) => Promise.resolve(byService[`${target.project}/${service ?? ''}`] ?? []),
    probeHealth: () => Promise.reject(new Error('unused')),
    freeBytes: () => Promise.resolve(0),
    images: () => Promise.resolve([]),
    removeImage: () => Promise.resolve(),
  };
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('buildReport', () => {
  it('reports manifests with content hashes, running digests per service, and versions', async () => {
    const files = new Map([
      [`${ROOT}/apps/web.yml`, manifestYaml('web')],
      [`${ROOT}/apps/api.yml`, manifestYaml('api', 30)],
    ]);
    const docker = fakeDocker({
      'web/web': [
        container('web', 'running', [
          `ghcr.io/matdemers1/other@${DIGEST_OTHER}`,
          `ghcr.io/matdemers1/web@${DIGEST_WEB}`,
        ]),
      ],
      // The worker is stopped: no digest observed.
      'web/worker': [container('worker', 'exited', [`ghcr.io/matdemers1/web-worker@${DIGEST_OTHER}`])],
      // api/web runs an image from another repository: not the manifest's, so null.
      'api/web': [container('web', 'running', [`ghcr.io/someone/else@${DIGEST_OTHER}`])],
    });

    const report = await buildReport(
      { fs: fakeFs(files), docker, engineApiVersion: () => Promise.resolve('1.51\n') },
      ROOT,
      { agentVersion: '0.3.0', patExpiresAt: '2026-12-31T00:00:00.000Z' },
    );

    expect(AgentReport.parse(report)).toEqual(report);
    expect(report).toMatchObject({
      agentVersion: '0.3.0',
      composeVersion: '5.0.1',
      engineApiVersion: '1.51',
      patExpiresAt: '2026-12-31T00:00:00.000Z',
    });
    expect(report.apps.map((a) => a.manifest.name)).toEqual(['api', 'web']);
    const web = report.apps.find((a) => a.manifest.name === 'web');
    expect(web?.manifestSha256).toBe(sha(manifestYaml('web')));
    expect(web?.running).toEqual({ web: DIGEST_WEB, worker: null });
    const api = report.apps.find((a) => a.manifest.name === 'api');
    expect(api?.manifest.soakSeconds).toBe(30);
    expect(api?.running).toEqual({ web: null, worker: null });
    expect(docker.composeCalls[0]?.args).toEqual(['version', '--short']);
  });

  it('reports no apps with an unknown compose version when there are no manifests', async () => {
    const report = await buildReport(
      { fs: fakeFs(new Map()), docker: fakeDocker({}), engineApiVersion: () => Promise.resolve('1.51') },
      ROOT,
      { agentVersion: '0.3.0', patExpiresAt: null },
    );
    expect(report.apps).toEqual([]);
    expect(report.composeVersion).toBe('unknown');
  });

  it('gives the same combined hash for disk and report, and a different one after an edit', async () => {
    const files = new Map([[`${ROOT}/apps/web.yml`, manifestYaml('web')]]);
    const fs = fakeFs(files);
    const ports = { fs, docker: fakeDocker({}), engineApiVersion: () => Promise.resolve('1.51') };
    const report = await buildReport(ports, ROOT, { agentVersion: '0', patExpiresAt: null });
    expect(await manifestsHash(fs, ROOT)).toBe(reportHash(report));
    files.set(`${ROOT}/apps/web.yml`, manifestYaml('web', 90));
    expect(await manifestsHash(fs, ROOT)).not.toBe(reportHash(report));
  });
});

/** A shared in-memory ledger file, as the agent and a host CLI process would share one on disk. */
function ledgerFs(): FsPort {
  const files = new Map<string, string>();
  return {
    readFile: (path) => Promise.resolve(files.get(path) ?? ''),
    writeFileAtomic: (path, content) => {
      files.set(path, content);
      return Promise.resolve();
    },
    appendLine: (path, line) => {
      files.set(path, `${files.get(path) ?? ''}${line}\n`);
      return Promise.resolve();
    },
    exists: (path) => Promise.resolve(files.has(path)),
    mkdirp: () => Promise.resolve(),
    list: () => Promise.resolve([]),
  };
}

function release(n: number, overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    app: 'web',
    deployId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    kind: 'deploy',
    sha: String(n % 10).repeat(40),
    images: [{ service: 'web', repo: 'ghcr.io/matdemers1/web', digest: DIGEST_WEB, migration: 'none' }],
    backupArtifact: null,
    at: new Date(Date.UTC(2026, 8, 25, 0, n)).toISOString(),
    ...overrides,
  };
}

describe('buildReport releases (SHP-REQ-111)', () => {
  it('carries the newest 20 ledger releases per reported app, including what another process appended', async () => {
    const files = new Map([
      [`${ROOT}/apps/web.yml`, manifestYaml('web')],
      [`${ROOT}/apps/api.yml`, manifestYaml('api')],
    ]);
    const fs = ledgerFs();
    const path = `${ROOT}/agent/ledger.jsonl`;
    const agentLedger = await Ledger.open(fs, path);
    // The host CLI: its own Ledger on the same file, appended after the agent opened it.
    const cli = await Ledger.open(fs, path);
    for (let n = 1; n <= 22; n++) await cli.append(release(n));
    await cli.append(release(23, { app: 'api', kind: 'rollback', images: [{ service: 'web', repo: 'ghcr.io/matdemers1/api', digest: DIGEST_OTHER, migration: null }] }));
    await cli.append({ kind: 'backup', app: 'web', deployId: 'b-1', backupArtifact: '/data/backups/web/1.dump', release: null, at: new Date().toISOString() });
    // An app the ledger knows but no manifest names is not reported.
    await cli.append(release(24, { app: 'gone' }));

    const report = await buildReport(
      { fs: fakeFs(files), docker: fakeDocker({}), engineApiVersion: () => Promise.resolve('1.51'), ledger: agentLedger },
      ROOT,
      { agentVersion: '0', patExpiresAt: null },
    );

    expect(AgentReport.parse(report)).toEqual(report);
    const releases = report.releases ?? [];
    expect(releases.filter((r) => r.app === 'web').map((r) => r.deployId)).toEqual(
      Array.from({ length: 20 }, (_, i) => release(i + 3).deployId),
    );
    expect(releases.filter((r) => r.app === 'api')).toEqual([
      { deployId: release(23).deployId, app: 'api', kind: 'rollback', sha: '3'.repeat(40), images: [{ service: 'web', repo: 'ghcr.io/matdemers1/api', digest: DIGEST_OTHER, migration: null }], at: release(23).at },
    ]);
    expect(releases.some((r) => r.app === 'gone')).toBe(false);
  });

  it('reports without releases when the ledger no longer verifies', async () => {
    const warn = vi.fn();
    const report = await buildReport(
      {
        fs: fakeFs(new Map()),
        docker: fakeDocker({}),
        engineApiVersion: () => Promise.resolve('1.51'),
        ledger: { refresh: () => Promise.reject(new Error('ledger tampered')), recent: () => [] },
        log: { info: vi.fn(), warn },
      },
      ROOT,
      { agentVersion: '0', patExpiresAt: null },
    );
    expect(report.releases).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('startReporting', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function recordingClient(): AgentClient & { sent: AgentReport[] } {
    const sent: AgentReport[] = [];
    return {
      sent,
      request: (_method, path, body) => {
        expect(path).toBe('/api/agent/report');
        sent.push(body as AgentReport);
        return Promise.resolve({});
      },
    };
  }

  it('sends on start, on every interval, and when the manifests change', async () => {
    vi.useFakeTimers();
    const files = new Map([[`${ROOT}/apps/web.yml`, manifestYaml('web')]]);
    const fs = fakeFs(files);
    const ports = { fs, docker: fakeDocker({}), engineApiVersion: () => Promise.resolve('1.51') };
    const client = recordingClient();

    const reporting = startReporting(client, () => buildReport(ports, ROOT, { agentVersion: '0', patExpiresAt: null }), {
      intervalMs: 60_000,
      checkMs: 1_000,
      currentHash: () => manifestsHash(fs, ROOT),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(client.sent).toHaveLength(1);

    // Unchanged manifests: checks alone send nothing.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.sent).toHaveLength(1);

    // An edit on the host: reported on the next check, well before the interval.
    files.set(`${ROOT}/apps/web.yml`, manifestYaml('web', 120));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.sent).toHaveLength(2);
    expect(client.sent[1]?.apps[0]?.manifest.soakSeconds).toBe(120);

    // And no further sends until the interval comes round.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(client.sent).toHaveLength(3);

    reporting.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(client.sent).toHaveLength(3);
  });

  it('logs a failed report and tries again on the next interval', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const warn = vi.fn();
    const client: AgentClient = {
      request: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('server down')) : Promise.resolve({});
      },
    };
    const reporting = startReporting(
      client,
      () => Promise.resolve({ agentVersion: '0', composeVersion: '5', engineApiVersion: '1.51', patExpiresAt: null, apps: [] }),
      { intervalMs: 1_000, log: { info: vi.fn(), warn } },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);
    reporting.stop();
  });
});
