import { isMap, isScalar, parseDocument } from 'yaml';

import { refusal } from '@shipyard/schema';

import { RefusalError } from './ports.js';
import type { FsPort } from './ports.js';

/**
 * Compose image-line rewrite (SHP-REQ-013, SHP-REQ-014). Rewrites only the literal `image:` lines
 * of manifest-mapped services, leaving every other byte of a hand-owned compose file untouched
 * (SHP-D-020) — comments, ordering, quoting, anchors, blank lines. Pure and file-agnostic: callers
 * decide which files make up a stack.
 */

export interface RewriteMapping {
  service: string;
  /** Untagged repository, e.g. `ghcr.io/matdemers1/foreman/server`. */
  repo: string;
  /** The literal value to write, e.g. `repo:sha-<40hex>@sha256:<digest>`. */
  reference: string;
}

export interface RewriteFile {
  path: string;
  text: string;
}

export interface RewritePlanFile {
  path: string;
  before: string;
  after: string;
  /** Service names whose image line changed in this file. */
  changed: string[];
}

interface FoundImage {
  fileIndex: number;
  /** Start/end offsets of the scalar's value within the file's text, replacement target. */
  range: [number, number];
  /** How the original scalar was quoted, so the rewrite keeps the same style. */
  quote: 'none' | '"' | "'";
  currentValue: string;
}

/**
 * Strips a `@sha256:...` digest suffix, then a `:tag` appearing after the last `/` (so a registry
 * port such as `registry:5000/toy/app:sha-...` is not mistaken for a tag).
 */
function repositoryOf(value: string): string {
  const atIndex = value.lastIndexOf('@');
  const withoutDigest = atIndex === -1 ? value : value.slice(0, atIndex);
  const lastSlash = withoutDigest.lastIndexOf('/');
  const tail = lastSlash === -1 ? withoutDigest : withoutDigest.slice(lastSlash + 1);
  const colonInTail = tail.lastIndexOf(':');
  if (colonInTail === -1) return withoutDigest;
  const tagStart = lastSlash === -1 ? colonInTail : lastSlash + 1 + colonInTail;
  return withoutDigest.slice(0, tagStart);
}

function findImage(text: string, service: string): { range: [number, number]; quote: FoundImage['quote']; currentValue: string } | null {
  const doc = parseDocument(text, { keepSourceTokens: true });
  const services = doc.get('services', true);
  if (!isMap(services)) return null;
  const svc = services.get(service, true);
  if (!isMap(svc)) return null;
  const imagePair = svc.items.find((p) => isScalar(p.key) && p.key.value === 'image');
  if (!imagePair) return null;
  const node = imagePair.value;
  if (!isScalar(node) || typeof node.value !== 'string') return null;
  const range = node.range;
  if (!range) return null;
  const quote: FoundImage['quote'] = node.type === 'QUOTE_DOUBLE' ? '"' : node.type === 'QUOTE_SINGLE' ? "'" : 'none';
  return { range: [range[0], range[1]], quote, currentValue: node.value };
}

/**
 * Plans the rewrite of every mapped service's image line across a stack's files. Pure: reads
 * nothing, writes nothing. Refuses (SHP-REQ-014) when a mapped service's image line is missing,
 * ambiguous (present in more than one file), foreign (a different repository), or unverifiable
 * (`${...}` interpolation).
 */
export function planRewrite(files: RewriteFile[], mappings: RewriteMapping[]): RewritePlanFile[] {
  // fileIndex -> list of { range, replacement }
  const editsByFile = new Map<number, { range: [number, number]; replacement: string; service: string }[]>();

  for (const mapping of mappings) {
    const matches: FoundImage[] = [];
    files.forEach((file, fileIndex) => {
      const found = findImage(file.text, mapping.service);
      if (found) matches.push({ fileIndex, ...found });
    });

    if (matches.length === 0) {
      throw new RefusalError(
        refusal(
          'image_line_invalid',
          `Service "${mapping.service}" has no image: line for it in any compose file.`,
        ),
      );
    }
    if (matches.length > 1) {
      const paths = matches.map((m) => files[m.fileIndex]?.path ?? '').join(', ');
      throw new RefusalError(
        refusal(
          'image_line_invalid',
          `Service "${mapping.service}" has an image: line in more than one compose file: ${paths}.`,
        ),
      );
    }

    const match = matches[0];
    if (!match) {
      throw new RefusalError(refusal('image_line_invalid', `Service "${mapping.service}" has no image: line for it in any compose file.`));
    }
    const matchPath = files[match.fileIndex]?.path ?? '';

    if (match.currentValue.includes('${')) {
      throw new RefusalError(
        refusal(
          'image_line_invalid',
          `Service "${mapping.service}" in ${matchPath} uses variable interpolation ("${match.currentValue}"), which cannot be verified.`,
        ),
      );
    }

    const currentRepo = repositoryOf(match.currentValue);
    if (currentRepo !== mapping.repo) {
      throw new RefusalError(
        refusal(
          'image_line_invalid',
          `Service "${mapping.service}" in ${matchPath} references repository "${currentRepo}", not the mapped "${mapping.repo}".`,
        ),
      );
    }

    const replacement = match.quote === 'none' ? mapping.reference : `${match.quote}${mapping.reference}${match.quote}`;
    const edits = editsByFile.get(match.fileIndex) ?? [];
    edits.push({ range: match.range, replacement, service: mapping.service });
    editsByFile.set(match.fileIndex, edits);
  }

  const plan: RewritePlanFile[] = [];
  files.forEach((file, i) => {
    const edits = editsByFile.get(i);
    if (!edits || edits.length === 0) {
      return;
    }
    // Apply from the end of the file backwards so earlier ranges stay valid.
    const sorted = [...edits].sort((a, b) => b.range[0] - a.range[0]);
    let after = file.text;
    for (const edit of sorted) {
      after = after.slice(0, edit.range[0]) + edit.replacement + after.slice(edit.range[1]);
    }
    plan.push({
      path: file.path,
      before: file.text,
      after,
      changed: edits.map((e) => e.service),
    });
  });
  return plan;
}

// ─── Apply / restore ──────────────────────────────────────────────────────────

export interface RewriteHistoryTarget {
  dir: string;
  deployId: string;
}

export interface HistoryManifestEntry {
  original: string;
  copy: string;
}

interface HistoryManifest {
  deployId: string;
  files: HistoryManifestEntry[];
}

function historyManifestPath(dir: string, deployId: string): string {
  return `${dir}/${deployId}/manifest.json`;
}

function historyCopyPath(dir: string, deployId: string, index: number, originalPath: string): string {
  const basename = originalPath.split('/').pop() ?? originalPath;
  return `${dir}/${deployId}/${String(index)}-${basename}`;
}

/**
 * Writes the planned files, keeping the previous content of each under `history.dir/history.deployId`
 * first, with a manifest mapping copies back to originals (SHP-REQ-013). If a write fails partway
 * through, the already-written files are restored from the history copies before rethrowing.
 */
export async function applyRewrite(
  fs: FsPort,
  plan: RewritePlanFile[],
  history: RewriteHistoryTarget,
): Promise<{ historyFiles: HistoryManifestEntry[] }> {
  const historyDir = `${history.dir}/${history.deployId}`;
  await fs.mkdirp(historyDir);

  const historyFiles: HistoryManifestEntry[] = [];
  for (const [i, file] of plan.entries()) {
    const copy = historyCopyPath(history.dir, history.deployId, i, file.path);
    await fs.writeFileAtomic(copy, file.before);
    historyFiles.push({ original: file.path, copy });
  }

  const manifest: HistoryManifest = { deployId: history.deployId, files: historyFiles };
  await fs.writeFileAtomic(historyManifestPath(history.dir, history.deployId), JSON.stringify(manifest, null, 2));

  const written: RewritePlanFile[] = [];
  try {
    for (const file of plan) {
      await fs.writeFileAtomic(file.path, file.after);
      written.push(file);
    }
  } catch (err) {
    for (const file of written) {
      await fs.writeFileAtomic(file.path, file.before);
    }
    throw err;
  }

  return { historyFiles };
}

/**
 * Writes each history-saved previous content back to its original path (rollback and crash
 * recovery). Returns the restored paths.
 */
export async function restoreFromHistory(fs: FsPort, historyDir: string, deployId: string): Promise<string[]> {
  const manifestPath = historyManifestPath(historyDir, deployId);
  const raw = await fs.readFile(manifestPath);
  const manifest = JSON.parse(raw) as HistoryManifest;

  const restored: string[] = [];
  for (const entry of manifest.files) {
    const content = await fs.readFile(entry.copy);
    await fs.writeFileAtomic(entry.original, content);
    restored.push(entry.original);
  }
  return restored;
}
