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
 * A line of a multi-line secret at least this long is a pattern of its own: log lines are split on
 * newlines before they are redacted, so a PEM key's body lines (64 characters) would otherwise
 * reach the server one by one (SHP-REQ-190).
 */
export const MIN_SECRET_LINE_LENGTH = 8;

/**
 * The values to redact from an action's output or a container's logs (SHP-REQ-190, as amended):
 * every env-file value of four or more characters that is not a boolean or a number of fewer than
 * six digits, every line of eight or more characters of a multi-line such value, and every
 * container Env value longer than eight characters. Only values: a variable's name is never a
 * secret and stays readable.
 *
 * Deliberately, env-file values `redact` treats as trivial — under four characters,
 * `true`/`false`, digit runs under six — are left out, the same rule step output has followed
 * since SHP-REQ-030: redacting them would blank every `true` and `3000` in a log, and none of
 * them is a secret worth the noise.
 *
 * A multi-line value is kept whole and each of its lines of eight characters or more is added as
 * well, since the log reader matches one line at a time. Lines shorter than that (a PEM key's
 * last `Zg==`, say) are accepted residue under the amended SHP-REQ-190: matching every short
 * fragment would blank ordinary words all over a log.
 *
 * `envFileValues` is what `loadRedactionValues` read (or a name → value map, as `loadSecrets`
 * gives).
 */
export function redactionValues(envFileValues: ReadonlyMap<string, string> | readonly string[], inspectedEnvValues: readonly string[]): string[] {
  const values = new Set<string>();
  const add = (value: string): void => {
    values.add(value);
    if (!/[\r\n]/.test(value)) return;
    for (const line of value.split(/\r?\n|\r/)) if (line.length >= MIN_SECRET_LINE_LENGTH) values.add(line);
  };
  const fromFiles: Iterable<string> = isMap(envFileValues) ? envFileValues.values() : envFileValues;
  for (const value of fromFiles) if (!isTrivial(value)) add(value);
  for (const value of inspectedEnvValues) if (value.length >= MIN_REDACTED_ENV_LENGTH) add(value);
  return [...values];
}

function isMap(value: ReadonlyMap<string, string> | readonly string[]): value is ReadonlyMap<string, string> {
  return value instanceof Map;
}

const ASSIGNMENT = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/;

/** Without surrounding quotes — also a lone opening or closing one, as on the first and last line of a value spanning lines. */
function stripQuotes(value: string): string {
  let v = value.trim();
  if (v.startsWith('"') || v.startsWith("'")) v = v.slice(1);
  if (v.endsWith('"') || v.endsWith("'")) v = v.slice(0, -1);
  return v;
}

/** godotenv's double-quote escapes, which compose applies: `\n` is a newline, `\"` a quote. */
function unescapeDoubleQuoted(value: string): string {
  return value.replace(/\\([nrt"\\$])/g, (_m, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c));
}

/** The index of the closing `quote` in `text` from `from`, skipping backslash escapes in double quotes; -1 when none. */
function closingQuote(text: string, from: number, quote: string): number {
  for (let i = from; i < text.length; i++) {
    if (quote === '"' && text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === quote) return i;
  }
  return -1;
}

/**
 * Every value in an env file that redaction must catch, read the way compose reads the file
 * (SHP-REQ-190): a single- or double-quoted value may span lines and loses its quotes (a double-
 * quoted one is taken both as written and with its escapes expanded), an unterminated quote runs
 * to the end of the file, and an unquoted value is the rest of its line. Belt and braces, every
 * line of the file that is not a `KEY=` assignment, and every assignment's value as written, are
 * added too when eight or more characters long once surrounding quotes are stripped — so a value
 * this reader misjudges still has its lines redacted.
 *
 * For redaction only: G9's env names, build secrets and deploy step output keep `parseEnvFile`.
 */
export function envFileRedactionValues(text: string): string[] {
  const out = new Set<string>();
  const addLong = (value: string): void => {
    const v = stripQuotes(value);
    if (v.length >= MIN_SECRET_LINE_LENGTH) out.add(v);
  };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const m = ASSIGNMENT.exec(line);
    if (m === null) {
      addLong(line);
      continue;
    }
    const rest = (m[2] ?? '').trimStart();
    addLong(rest);
    const quote = rest[0];
    if (quote !== '"' && quote !== "'") {
      out.add(rest.trim());
      // An unquoted value ends at an inline comment, as compose reads it.
      const hash = rest.search(/\s#/);
      if (hash !== -1) out.add(rest.slice(0, hash).trim());
      continue;
    }
    // A quoted value: find its end, on this line or a later one.
    let body = rest.slice(1);
    let end = closingQuote(body, 0, quote);
    let j = i;
    while (end === -1 && j + 1 < lines.length) {
      j++;
      const from = body.length + 1;
      body = `${body}\n${lines[j] ?? ''}`;
      end = closingQuote(body, from, quote);
    }
    const value = end === -1 ? body : body.slice(0, end);
    out.add(value);
    if (quote === '"') out.add(unescapeDoubleQuoted(value));
    // Every line the value spanned is also a line of the file.
    for (let k = i + 1; k <= j; k++) addLong(lines[k] ?? '');
    i = j;
  }
  // A strict superset of parseEnvFile, which deploy step output has always been redacted against: a
  // name this reader's pattern refuses (a digit-leading name, KEY[0]=…) still has its value redacted
  // on its own, not only as a whole line (SHP-REQ-190).
  // Its line-at-a-time values may keep one stray quote of a value that spans lines; drop it.
  for (const value of parseEnvFile(text).values()) out.add(value.replace(/^["']|["']$/g, ''));
  return [...out].filter((v) => v.length > 0);
}

/** The redaction values of every env file (see `envFileRedactionValues`); a missing file is an error naming it. */
export async function loadRedactionValues(fs: FsPort, envFiles: string[] | undefined): Promise<string[]> {
  const values: string[] = [];
  for (const file of envFiles ?? []) {
    if (!(await fs.exists(file))) throw new Error(`env file does not exist: ${file}`);
    values.push(...envFileRedactionValues(await fs.readFile(file)));
  }
  return values;
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

/**
 * Where text that continues in a next piece may be cut without splitting a secret: `cut`, moved
 * left to the start of any occurrence of one of `values` that would straddle it. What lies after
 * the returned index is carried into the next piece and redacted there, whole.
 */
export function safeCut(text: string, values: readonly string[], cut: number): number {
  let at = Math.max(0, Math.min(cut, text.length));
  for (let moved = true; moved; ) {
    moved = false;
    for (const value of values) {
      if (value.length < 2) continue;
      for (let i = text.indexOf(value, Math.max(0, at - value.length + 1)); i !== -1 && i < at; i = text.indexOf(value, i + 1)) {
        if (i + value.length > at) {
          at = i;
          moved = true;
          break;
        }
      }
    }
  }
  return at;
}
