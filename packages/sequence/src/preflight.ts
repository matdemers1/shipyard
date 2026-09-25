import { LABEL_ENV } from './types.js';

/**
 * Env preflight from image-declared variable names (SHP-T-5.5, SHP-REQ-082). An image may declare,
 * via the `dev.d3cloud.shipyard.env` OCI label, the environment variable names it needs at runtime.
 * G9 (gates.ts) requires the union of the manifest's `requiredEnv` and every mapped image's declared
 * names to be present in the stack's env files, and refuses naming any that is missing.
 *
 * Only names ever leave this module — never values, and nothing here reads an env file.
 */

/** A declared env name must look like a shell/POSIX identifier. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface DeclaredEnv {
  /** Valid names declared by the label, in label order, de-duplicated. */
  names: string[];
  /** Raw entries that failed the name pattern, in label order. Non-empty means a malformed label. */
  invalid: string[];
}

/**
 * Parses `dev.d3cloud.shipyard.env` off a verified image's labels: comma-separated names,
 * whitespace around each entry tolerated, empty entries ignored. An entry that is not a valid
 * identifier is reported in `invalid` rather than silently dropped, so a malformed label can be
 * refused instead of read as "this image needs nothing."
 */
export function declaredEnv(labels: Record<string, string>): DeclaredEnv {
  const raw = labels[LABEL_ENV];
  if (raw === undefined) return { names: [], invalid: [] };
  const names: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    if (!ENV_NAME_RE.test(trimmed)) {
      invalid.push(trimmed);
      continue;
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    names.push(trimmed);
  }
  return { names, invalid };
}

/** The names in `required` that are absent from `present`, in `required` order, de-duplicated. */
export function missingEnv(required: string[], present: string[]): string[] {
  const presentSet = new Set(present);
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const name of required) {
    if (presentSet.has(name) || seen.has(name)) continue;
    seen.add(name);
    missing.push(name);
  }
  return missing;
}
