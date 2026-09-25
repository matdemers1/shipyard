import { createHash } from 'node:crypto';
import { Digest, REPORTED_RELEASES_PER_APP, type AgentReport } from '@shipyard/schema';
import { loadManifests, type DockerPort, type FsPort, type LedgerEntry, type LoadedManifest } from '@shipyard/sequence';
import type { AgentClient } from './client.js';

/**
 * The agent's report (SHP-REQ-036, SHP-D-060): its parsed manifests with content hashes, and the
 * digest each mapped service is running. Sent on start, on an interval, and whenever the manifests
 * change — the periodic report is what turns an SSH change into drift on the next poll
 * (SHP-REQ-054). The server mirrors it; it never tells the agent what its manifests say.
 *
 * It also carries the ledger's verified releases, the newest `REPORTED_RELEASES_PER_APP` per app
 * (SHP-REQ-111), so a deploy made on the host with the CLI shows up on the server as the live
 * release and as a rollback target.
 */

export interface ReportPorts {
  fs: FsPort;
  docker: DockerPort;
  /** The Docker Engine API version (`GET /version` → `ApiVersion`). */
  engineApiVersion(): Promise<string>;
  /**
   * The agent's ledger, shared with the engine. `refresh` adopts what another process (the host
   * CLI) appended; `recent` is newest first. Absent: the report carries no releases.
   */
  ledger?: { refresh(): Promise<void>; recent(app: string, n?: number): LedgerEntry[] };
  log?: ReportLog;
}

export interface ReportVersions {
  agentVersion: string;
  /** When the GHCR/GitHub PAT expires (ISO), or null when unknown or none. */
  patExpiresAt: string | null;
}

const UNKNOWN = 'unknown';

/** One hash over every manifest's name and content hash, so any add, remove or edit changes it. */
export function combinedHash(entries: Iterable<{ name: string; sha256: string }>): string {
  const lines = [...entries].map((e) => `${e.name} ${e.sha256}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** The combined hash of the manifests currently on disk. Throws as `loadManifests` does. */
export async function manifestsHash(fs: FsPort, dataRoot: string): Promise<string> {
  const loaded = await loadManifests(fs, dataRoot);
  return combinedHash([...loaded].map(([name, m]) => ({ name, sha256: m.sha256 })));
}

/** The combined hash of the manifests a report carries. */
export function reportHash(report: AgentReport): string {
  return combinedHash(report.apps.map((a) => ({ name: a.manifest.name, sha256: a.manifestSha256 })));
}

/**
 * The digest a running container of `image` carries: its RepoDigest for exactly that repository.
 * Null when no container is running, or none carries a digest for the manifest's image.
 */
async function runningDigest(docker: DockerPort, loaded: LoadedManifest, service: string, image: string): Promise<Digest | null> {
  const containers = await docker.containers(loaded.manifest.compose, service);
  for (const c of containers) {
    if (c.state !== 'running') continue;
    for (const ref of c.repoDigests) {
      const at = ref.lastIndexOf('@');
      if (at < 0 || ref.slice(0, at) !== image) continue;
      const parsed = Digest.safeParse(ref.slice(at + 1));
      if (parsed.success) return parsed.data;
    }
  }
  return null;
}

async function composeVersion(docker: DockerPort, manifests: LoadedManifest[]): Promise<string> {
  const first = manifests[0];
  if (first === undefined) return UNKNOWN;
  const res = await docker.compose(first.manifest.compose, ['version', '--short']);
  const out = res.stdout.trim();
  return res.exitCode === 0 && out.length > 0 ? out : UNKNOWN;
}

export async function buildReport(ports: ReportPorts, dataRoot: string, versions: ReportVersions): Promise<AgentReport> {
  const loaded = [...(await loadManifests(ports.fs, dataRoot)).values()].sort((a, b) =>
    a.manifest.name.localeCompare(b.manifest.name),
  );

  const apps: AgentReport['apps'] = [];
  for (const m of loaded) {
    const running: Record<string, Digest | null> = {};
    for (const [service, config] of Object.entries(m.manifest.services)) {
      running[service] = await runningDigest(ports.docker, m, service, config.image);
    }
    apps.push({ manifest: m.manifest, manifestSha256: m.sha256, running });
  }

  const engine = (await ports.engineApiVersion()).trim();
  const releases = await ledgerReleases(ports, loaded);
  return {
    agentVersion: versions.agentVersion,
    composeVersion: await composeVersion(ports.docker, loaded),
    engineApiVersion: engine.length > 0 ? engine : UNKNOWN,
    patExpiresAt: versions.patExpiresAt,
    apps,
    ...(releases === undefined ? {} : { releases }),
  };
}

/**
 * The newest `REPORTED_RELEASES_PER_APP` ledger releases of each reported app, oldest first. A
 * ledger that fails to refresh (a chain that no longer verifies) is logged and left out, so the
 * report — the agent's heartbeat — still goes.
 */
async function ledgerReleases(ports: ReportPorts, loaded: LoadedManifest[]): Promise<AgentReport['releases']> {
  const ledger = ports.ledger;
  if (ledger === undefined) return undefined;
  try {
    await ledger.refresh();
  } catch (err) {
    ports.log?.warn({ err: err instanceof Error ? err.message : String(err) }, 'ledger refresh failed; reporting without releases');
    return undefined;
  }
  return loaded.flatMap((m) =>
    ledger
      .recent(m.manifest.name, REPORTED_RELEASES_PER_APP)
      .reverse()
      .map((e) => ({
        deployId: e.deployId,
        app: e.app,
        kind: e.kind,
        sha: e.sha,
        images: e.images.map((i) => ({ service: i.service, repo: i.repo, digest: i.digest, migration: i.migration ?? null })),
        at: e.at,
      })),
  );
}

export interface ReportLog {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface ReportingOptions {
  /** A full report at least this often. */
  intervalMs?: number;
  /** How often to look at the manifests' combined hash for a change. */
  checkMs?: number;
  /** The manifests' combined hash as it is on disk now; a change sends a report at once. */
  currentHash?: () => Promise<string>;
  log?: ReportLog;
}

export interface Reporting {
  /** Sends a report now (serialised with any report already in flight). */
  sendNow(): Promise<void>;
  stop(): void;
}

/**
 * Sends a report on start, then every `intervalMs`, and as soon as `currentHash` differs from the
 * hash of the last report sent. A failed report is logged and retried on the next tick; it never
 * throws out of a timer.
 */
export function startReporting(
  client: AgentClient,
  build: () => Promise<AgentReport>,
  opts: ReportingOptions = {},
): Reporting {
  const intervalMs = opts.intervalMs ?? 60_000;
  const checkMs = opts.checkMs ?? 5_000;
  let lastHash: string | null = null;
  let chain: Promise<void> = Promise.resolve();
  let stopped = false;

  const send = async (): Promise<void> => {
    try {
      const report = await build();
      await client.request('POST', '/api/agent/report', report);
      lastHash = reportHash(report);
    } catch (err) {
      opts.log?.warn({ err }, 'agent report failed');
    }
  };

  const sendNow = (): Promise<void> => {
    if (stopped) return chain;
    chain = chain.then(send);
    return chain;
  };

  const check = async (): Promise<void> => {
    if (opts.currentHash === undefined || lastHash === null) return;
    let now: string;
    try {
      now = await opts.currentHash();
    } catch (err) {
      opts.log?.warn({ err }, 'manifest check failed');
      return;
    }
    if (now !== lastHash) {
      opts.log?.info({}, 'manifests changed; reporting');
      await sendNow();
    }
  };

  void sendNow();
  const interval = setInterval(() => void sendNow(), intervalMs);
  const checker = opts.currentHash === undefined ? null : setInterval(() => void check(), checkMs);
  interval.unref();
  checker?.unref();

  return {
    sendNow,
    stop() {
      stopped = true;
      clearInterval(interval);
      if (checker !== null) clearInterval(checker);
    },
  };
}
