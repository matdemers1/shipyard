import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Stats } from 'node:fs';
import { refusal } from '@shipyard/schema';
import type { Manifest } from '@shipyard/schema';
import * as tar from 'tar';
import type { ReadEntry } from 'tar';

import { RefusalError } from '../ports.js';
import type { GitHubPort, Log } from '../ports.js';

/**
 * Fetches build source into a scratch directory and cleans it up (SHP-T-7.6, SHP-REQ-115,
 * SHP-REQ-116, SHP-REQ-149). No `git` binary is ever invoked — source comes only from GitHub's
 * tarball of the exact 40-hex SHA, fetched by `GitHubPort.tarball` and extracted in-process.
 */

const SHA_RE = /^[0-9a-f]{40}$/;
const DEFAULT_MAX_FILES = 200_000;
const DEFAULT_MAX_BYTES = 2 * 1024 ** 3;

export interface FetchSourceOptions {
  manifests: Map<string, Manifest> | Record<string, Manifest>;
  app: string;
  sha: string;
  github: GitHubPort;
  /** Directory the scratch directory is created under (default `os.tmpdir()`). */
  scratchRoot?: string;
  log?: Log;
  /** Cap on extracted entry count. Default 200,000. */
  maxFiles?: number;
  /** Cap on total extracted bytes. Default 2 GiB. */
  maxBytes?: number;
}

function lookupManifest(manifests: FetchSourceOptions['manifests'], app: string): Manifest | undefined {
  if (manifests instanceof Map) return manifests.get(app);
  return Object.prototype.hasOwnProperty.call(manifests, app) ? manifests[app] : undefined;
}

/**
 * Resolves a raw archive-entry path against `scratchDir` as `tar`'s own `strip: 1` would: the
 * archive's single top-level directory (`<owner>-<repo>-<sha7>/`) is dropped. Returns:
 * - `null` if the path is unsafe (absolute, or containing a `..` segment, or the resolved target
 *   escapes `scratchDir`),
 * - `undefined` if nothing is left after stripping the top-level segment (the top directory entry
 *   itself — harmless, just excluded),
 * - the resolved absolute path otherwise.
 */
function resolveEntryPath(scratchDir: string, rawPath: string): string | null | undefined {
  const normalized = rawPath.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return null;
  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === '..')) return null;
  if (segments.length <= 1) return undefined;
  const stripped = segments.slice(1).join('/');
  if (stripped.length === 0) return undefined;
  const target = resolvePath(scratchDir, stripped);
  if (target !== scratchDir && !target.startsWith(scratchDir + sep)) return null;
  return target;
}

/** A symlink's target is a filesystem-style path relative to the symlink's own directory. */
function isSafeSymlinkTarget(entryAbsolutePath: string, rawLinkpath: string, scratchDir: string): boolean {
  const normalized = rawLinkpath.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return false;
  const resolved = resolvePath(dirname(entryAbsolutePath), normalized);
  return resolved === scratchDir || resolved.startsWith(scratchDir + sep);
}

const UNSUPPORTED_TYPES = new Set(['CharacterDevice', 'BlockDevice', 'FIFO']);

/**
 * Extracts a gzip tarball stream into `scratchDir`, stripping GitHub's single top-level directory.
 * Rejects the whole archive — never silently skips an entry — on a path that escapes, a symlink or
 * hardlink that escapes, an unsupported entry type, or a size/count cap exceeded.
 */
async function extractTarball(
  body: ReadableStream<Uint8Array>,
  scratchDir: string,
  limits: { maxFiles: number; maxBytes: number },
): Promise<void> {
  let unsafe: string | null = null;
  let fileCount = 0;
  let byteTotal = 0;

  const extractor = tar.x({
    cwd: scratchDir,
    strip: 1,
    strict: true,
    filter(rawPath: string, statOrEntry: Stats | ReadEntry): boolean {
      if (unsafe !== null) return false;
      const entry = statOrEntry as ReadEntry;

      fileCount += 1;
      if (fileCount > limits.maxFiles) {
        unsafe = `too many entries (over ${String(limits.maxFiles)})`;
        return false;
      }
      const size = typeof entry.size === 'number' ? entry.size : 0;
      byteTotal += size;
      if (byteTotal > limits.maxBytes) {
        unsafe = `archive exceeds ${String(limits.maxBytes)} extracted bytes`;
        return false;
      }

      if (UNSUPPORTED_TYPES.has(entry.type)) {
        unsafe = `entry '${rawPath}' has an unsupported type (${entry.type})`;
        return false;
      }

      const target = resolveEntryPath(scratchDir, rawPath);
      if (target === null) {
        unsafe = `entry '${rawPath}' is unsafe: it escapes the scratch directory`;
        return false;
      }
      if (target === undefined) return false; // the top-level directory entry itself

      if (entry.type === 'SymbolicLink' && typeof entry.linkpath === 'string') {
        if (!isSafeSymlinkTarget(target, entry.linkpath, scratchDir)) {
          unsafe = `symlink '${rawPath}' -> '${entry.linkpath}' is unsafe: it escapes the scratch directory`;
          return false;
        }
      }
      if (entry.type === 'Link' && typeof entry.linkpath === 'string') {
        const linkTarget = resolveEntryPath(scratchDir, entry.linkpath);
        if (linkTarget === null || linkTarget === undefined) {
          unsafe = `hardlink '${rawPath}' -> '${entry.linkpath}' is unsafe: it escapes the scratch directory`;
          return false;
        }
      }

      return true;
    },
  });

  const nodeBody = Readable.fromWeb(body as never);

  try {
    await pipeline(nodeBody, extractor);
  } catch (err) {
    if (unsafe !== null) {
      throw new RefusalError(refusal('github_unreachable', `GitHub archive entry is unsafe: ${unsafe}`));
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new RefusalError(refusal('github_unreachable', `GitHub archive is malformed or could not be extracted: ${message}`));
  }

  if (unsafe !== null) {
    throw new RefusalError(refusal('github_unreachable', `GitHub archive entry is unsafe: ${unsafe}`));
  }
}

/**
 * Fetches build source for `app`@`sha` into a fresh scratch directory and runs `use(dir, manifest)`
 * against it, removing the scratch directory afterwards no matter what happens — success, a
 * refusal, or `use` throwing (SHP-REQ-116).
 *
 * Order: `app` must be a known manifest (SHP-REQ-149) before any GitHub call; `sha` must be
 * 40-hex; the SHA must be on the manifest's default branch (SHP-REQ-115) before any source is
 * fetched; then, and only then, the tarball is streamed and extracted.
 */
export async function withBuildSource<T>(opts: FetchSourceOptions, use: (dir: string, manifest: Manifest) => Promise<T>): Promise<T> {
  const manifest = lookupManifest(opts.manifests, opts.app);
  if (manifest === undefined) {
    throw new RefusalError(refusal('unknown_app', `'${opts.app}' is not in the agent's local manifests`));
  }

  if (!SHA_RE.test(opts.sha)) {
    throw new RefusalError(refusal('invalid_request', `'${opts.sha}' is not a 40-hex commit SHA`));
  }

  const comparison = await opts.github.compare(manifest.repo, opts.sha, manifest.defaultBranch);
  const onBranch = comparison !== null && (comparison.status === 'ahead' || comparison.status === 'identical');
  if (!onBranch) {
    const status = comparison === null ? 'unknown to GitHub' : comparison.status;
    const message = `${opts.sha.slice(0, 7)} is not on ${manifest.defaultBranch} (${status})`;
    throw new RefusalError(refusal('not_on_default_branch', message));
  }

  if (opts.github.tarball === undefined) {
    throw new RefusalError(refusal('github_unreachable', 'the configured GitHub adapter cannot fetch tarballs'));
  }

  const scratchRoot = opts.scratchRoot ?? tmpdir();
  await mkdir(scratchRoot, { recursive: true });
  const prefix = join(scratchRoot, `build-${opts.app}-${opts.sha.slice(0, 7)}-`);
  const scratchDir = await mkdtemp(prefix);
  await chmod(scratchDir, 0o700);

  try {
    const body = await opts.github.tarball(manifest.repo, opts.sha);
    await extractTarball(body, scratchDir, {
      maxFiles: opts.maxFiles ?? DEFAULT_MAX_FILES,
      maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
    });
    opts.log?.info({ app: opts.app, sha: opts.sha, scratchDir }, 'build source extracted');
    return await use(scratchDir, manifest);
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}
