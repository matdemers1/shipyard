import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import { Manifest, refusal, type Refusal } from '@shipyard/schema';
import { parse as parseYaml, YAMLParseError } from 'yaml';

import type { FsPort } from './ports.js';

/**
 * Manifest loading (SHP-T-1.1, SHP-REQ-026). Reads every `*.yml` / `*.yaml` directly inside
 * `<dataRoot>/apps`, validates each against the shared schema, and refuses to start — naming the
 * file and field — if any fails. Directory recursion, other file types and everything else in the
 * data root are ignored.
 */

/** One validation problem, always tied to the file and the field path that caused it. */
export interface ManifestIssue {
  file: string;
  /** Dot-joined field path (array indexes as `[0]`), or `''` when the problem is not field-scoped. */
  path: string;
  message: string;
}

export interface LoadedManifest {
  manifest: Manifest;
  file: string;
  /** Hex sha256 of the file's exact bytes (SHP-REQ-036). */
  sha256: string;
}

/** app name → its loaded manifest. */
export type LoadedManifests = Map<string, LoadedManifest>;

/** Thrown to refuse to start: aggregates every issue found across every manifest file. */
export class ManifestLoadError extends Error {
  readonly issues: ManifestIssue[];

  constructor(issues: ManifestIssue[]) {
    super(ManifestLoadError.formatMessage(issues));
    this.name = 'ManifestLoadError';
    this.issues = issues;
  }

  toRefusal(): Refusal {
    return refusal('manifest_invalid', this.message);
  }

  private static formatMessage(issues: ManifestIssue[]): string {
    return issues.map((issue) => (issue.path.length > 0 ? `${issue.file}: ${issue.path}: ${issue.message}` : `${issue.file}: ${issue.message}`)).join('; ');
  }
}

/** Reads and validates every manifest in `<dataRoot>/apps`; throws `ManifestLoadError` on any failure. */
export async function loadManifests(fs: FsPort, dataRoot: string): Promise<LoadedManifests> {
  const appsDir = `${dataRoot}/apps`;

  if (!(await fs.exists(appsDir))) {
    throw new ManifestLoadError([{ file: appsDir, path: '', message: 'apps directory does not exist' }]);
  }

  const entries = await fs.list(appsDir);
  const files = entries
    .map((entry) => entry.path)
    .filter((path) => /\.ya?ml$/i.test(path))
    .toSorted((a, b) => a.localeCompare(b));

  const issues: ManifestIssue[] = [];
  const loaded: LoadedManifests = new Map();
  const nameOwner = new Map<string, string>();

  for (const file of files) {
    const text = await fs.readFile(file);

    let parsed: unknown;
    try {
      parsed = parseYaml(text);
    } catch (error) {
      issues.push({ file, path: '', message: yamlErrorMessage(error) });
      continue;
    }

    const result = Manifest.safeParse(parsed);
    if (!result.success) {
      for (const zodIssue of result.error.issues) {
        if (zodIssue.code === 'unrecognized_keys') {
          for (const key of zodIssue.keys) {
            issues.push({ file, path: fieldPath([...zodIssue.path, key]), message: `unrecognized key "${key}"` });
          }
        } else {
          issues.push({ file, path: fieldPath(zodIssue.path), message: zodIssue.message });
        }
      }
      continue;
    }

    const manifest = result.data;
    const stem = basename(file).replace(/\.ya?ml$/i, '');
    if (manifest.name !== stem) {
      issues.push({ file, path: 'name', message: `manifest name "${manifest.name}" does not match filename "${stem}"` });
      continue;
    }

    const owner = nameOwner.get(manifest.name);
    if (owner !== undefined) {
      issues.push({ file, path: 'name', message: `duplicate app name "${manifest.name}", already declared in ${owner}` });
      continue;
    }

    nameOwner.set(manifest.name, file);
    const sha256 = createHash('sha256').update(Buffer.from(text, 'utf-8')).digest('hex');
    loaded.set(manifest.name, { manifest, file, sha256 });
  }

  if (issues.length > 0) {
    throw new ManifestLoadError(issues);
  }

  return loaded;
}

function fieldPath(path: PropertyKey[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${segment}]`;
    } else {
      const name = String(segment);
      out += out.length > 0 ? `.${name}` : name;
    }
  }
  return out;
}

function yamlErrorMessage(error: unknown): string {
  if (error instanceof YAMLParseError) {
    const line = error.linePos?.[0]?.line;
    return line !== undefined ? `invalid YAML at line ${String(line)}: ${error.message}` : `invalid YAML: ${error.message}`;
  }
  return error instanceof Error ? `invalid YAML: ${error.message}` : 'invalid YAML';
}
