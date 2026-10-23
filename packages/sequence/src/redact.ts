import type { FsPort } from './ports.js';

/**
 * Output redaction (SHP-REQ-030, SHP-D-082). Every value read from the stack's env files is
 * replaced by its redacted name before a step's output is ever stored, and only the last 50 lines
 * of the result are kept. Values too short or too common to be a secret (booleans, short digit
 * runs) are left alone so ordinary log lines are not turned into noise.
 */

const MAX_STORED_LINES = 50;
const MIN_VALUE_LENGTH = 4;
const TRIVIAL_VALUES = new Set(['true', 'false']);

/** Parses `KEY=value` lines (optionally `export KEY=value`), skipping blanks and `#` comments. */
export function parseEnvFile(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trimStart() : line;
    const eq = withoutExport.indexOf('=');
    if (eq === -1) continue;

    const name = withoutExport.slice(0, eq).trim();
    if (name.length === 0) continue;

    let value = withoutExport.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }

    entries.set(name, value);
  }
  return entries;
}

/** Reads and merges every env file's entries; a missing file is an error naming it. */
export async function loadSecrets(fs: FsPort, envFiles: string[] | undefined): Promise<Map<string, string>> {
  const merged = new Map<string, string>();
  if (!envFiles) return merged;

  for (const file of envFiles) {
    if (!(await fs.exists(file))) {
      throw new Error(`env file does not exist: ${file}`);
    }
    const text = await fs.readFile(file);
    for (const [name, value] of parseEnvFile(text)) {
      merged.set(name, value);
    }
  }
  return merged;
}

function isTrivial(value: string): boolean {
  if (value.length < MIN_VALUE_LENGTH) return true;
  if (TRIVIAL_VALUES.has(value.toLowerCase())) return true;
  if (/^\d+$/.test(value) && value.length < 6) return true;
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replaces every secret value with its redacted name (longest values first), then caps to 50 lines. */
export function redact(output: string, secrets: Map<string, string>): string {
  const candidates = [...secrets.entries()].filter(([, value]) => !isTrivial(value));
  candidates.sort((a, b) => b[1].length - a[1].length);

  let result = output;
  for (const [name, value] of candidates) {
    const pattern = new RegExp(escapeRegExp(value), 'g');
    result = result.replace(pattern, `«redacted:${name}»`);
  }

  const lines = result.split('\n');
  return lines.slice(Math.max(0, lines.length - MAX_STORED_LINES)).join('\n');
}

// ─── Action output and container logs (SHP-REQ-190, SHP-ADR-011) ─────────────

/** What every secret value becomes in a lifecycle action's output or a log line. */
export const REDACTED = '[redacted]';

/**
 * A container Env value is redacted when it is longer than this (SHP-REQ-190). Env carries
 * ordinary settings too (`PORT=3000`, `NODE_ENV=production`), and blanking every short value would
 * turn a log into noise; a credential is longer than eight characters.
 */
export const MIN_REDACTED_ENV_LENGTH = 9;

/**
 * The values to redact from an action's output or a container's logs: every env-file value of the
 * matching manifest or stack (less the trivial ones `redact` already skips, so `true` or `3000`
 * never blanks a log), and every inspected container Env value longer than eight characters. Only
 * values: a variable's name is never a secret and stays readable.
 */
export function redactionValues(envFileSecrets: ReadonlyMap<string, string>, inspectedEnvValues: readonly string[]): string[] {
  const values = new Set<string>();
  for (const value of envFileSecrets.values()) if (!isTrivial(value)) values.add(value);
  for (const value of inspectedEnvValues) if (value.length >= MIN_REDACTED_ENV_LENGTH) values.add(value);
  return [...values];
}

/**
 * A redactor replacing every one of `values` with `[redacted]`. One regular expression with the
 * longest values first, so a value containing another is replaced whole, and so a log stream of
 * thousands of lines does not build a pattern per line.
 */
export function createRedactor(values: readonly string[]): (text: string) => string {
  const usable = [...new Set(values)].filter((v) => v.length > 0).sort((a, b) => b.length - a.length);
  if (usable.length === 0) return (text) => text;
  const pattern = new RegExp(usable.map(escapeRegExp).join('|'), 'g');
  return (text) => text.replace(pattern, REDACTED);
}
