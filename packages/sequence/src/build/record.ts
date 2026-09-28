import { join } from 'node:path';
import type { Digest } from '@shipyard/schema';

import type { FsPort } from '../ports.js';

/**
 * The agent-local build record (SHP-T-7.7, SHP-REQ-128): one JSONL file per app at
 * `<dataRoot>/builds/<app>.jsonl`, appended when a build ends. Gate G5 reads this for a
 * Shipyard-built app (SHP-T-7.10) — never a claim from the server. It holds IDs, the SHA, the
 * state and digests only: no secret and no log content. Malformed lines are skipped, never fatal.
 */

export interface BuildRecord {
  buildId: string;
  app: string;
  sha: string;
  state: 'succeeded' | 'failed' | 'cancelled' | 'refused';
  /** Keyed by compose service. */
  digests: Record<string, Digest>;
  /** ISO timestamp. */
  at: string;
}

const APP_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const STATES = new Set(['succeeded', 'failed', 'cancelled', 'refused']);

export function buildRecordPath(dataRoot: string, app: string): string {
  if (!APP_RE.test(app)) throw new Error(`invalid app name for a build record: ${JSON.stringify(app)}`);
  return join(dataRoot, 'builds', `${app}.jsonl`);
}

function parseRecord(line: string): BuildRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.buildId !== 'string' || typeof r.app !== 'string' || typeof r.at !== 'string') return null;
  if (typeof r.sha !== 'string' || !SHA_RE.test(r.sha)) return null;
  if (typeof r.state !== 'string' || !STATES.has(r.state)) return null;
  if (typeof r.digests !== 'object' || r.digests === null || Array.isArray(r.digests)) return null;
  const digests: Record<string, Digest> = {};
  for (const [service, digest] of Object.entries(r.digests as Record<string, unknown>)) {
    if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) return null;
    digests[service] = digest;
  }
  return { buildId: r.buildId, app: r.app, sha: r.sha, state: r.state as BuildRecord['state'], digests, at: r.at };
}

/** Appends one record, under the file's cross-process lock when the FsPort has one. */
export async function appendBuildRecord(fs: FsPort, dataRoot: string, record: BuildRecord): Promise<void> {
  const path = buildRecordPath(dataRoot, record.app);
  const line = JSON.stringify({
    buildId: record.buildId,
    app: record.app,
    sha: record.sha,
    state: record.state,
    digests: record.digests,
    at: record.at,
  });
  await fs.mkdirp(join(dataRoot, 'builds'));
  const release = fs.lock ? await fs.lock(path) : undefined;
  try {
    await fs.appendLine(path, line);
  } finally {
    if (release) await release();
  }
}

/** The last succeeded build of exactly this app and SHA, or null. */
export async function latestSucceededBuild(fs: FsPort, dataRoot: string, app: string, sha: string): Promise<BuildRecord | null> {
  const path = buildRecordPath(dataRoot, app);
  if (!(await fs.exists(path))) return null;
  const text = await fs.readFile(path);
  let latest: BuildRecord | null = null;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const record = parseRecord(line);
    if (record?.app === app && record.sha === sha && record.state === 'succeeded' && Object.keys(record.digests).length > 0) {
      latest = record;
    }
  }
  return latest;
}
