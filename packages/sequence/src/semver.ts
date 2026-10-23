/**
 * A small semver range matcher for stack tracks (SHP-ADR-010, SHP-REQ-194): `{ semver: '17.x' }`
 * follows the highest registry tag inside the range. Written here rather than taken from a package
 * because the grammar a stack manifest allows is tiny (the schema admits digits, `x`, `*`, `^`,
 * `~`, comparators, `||` and spaces) and the rules for tags are not npm's: registry tags are often
 * partial (`17`, `17.2`) and carry suffixes (`17.2-alpine`).
 *
 * - Tags: an optional `v`, one to three numeric parts, an optional `-pre-release`. Anything else
 *   (`latest`, `4.0.11.2680-ls262`) is not a version and is never picked.
 * - Ranges: `*`/`x`, x-ranges and partials (`17`, `17.x`, `17.1.x`, `17.1`), `^`, `~`, exact
 *   versions, `>`, `>=`, `<`, `<=`, `=`, space-separated (all must hold) and `||` (any set).
 * - Pre-release (and suffixed) tags are ignored unless a comparator of the range names a pre-release
 *   of the same major.minor.patch — npm's rule. `17.x` never picks `17.2-alpine`.
 * - Of two tags naming the same version (`17.2` and `17.2.0`), the more specific one wins.
 */

export interface TagVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated pre-release identifiers; empty for a release. */
  pre: string[];
  /** How many numeric parts the tag spelt out (1–3). */
  parts: number;
}

const TAG_RE = /^v?(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*))?(?:\.(0|[1-9][0-9]*))?(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/;

/** The version a tag names, or null when it names none. */
export function parseTagVersion(tag: string): TagVersion | null {
  const m = TAG_RE.exec(tag);
  if (m === null) return null;
  const nums = [m[1], m[2], m[3]];
  const parts = nums.filter((n) => n !== undefined).length;
  const [major = 0, minor = 0, patch = 0] = nums.map((n) => (n === undefined ? 0 : Number(n)));
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch, pre: m[4] === undefined ? [] : m[4].split('.'), parts };
}

function comparePre(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  // A release is higher than any of its pre-releases.
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^[0-9]+$/.test(x);
    const yn = /^[0-9]+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return Math.sign(d);
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function compareVersions(a: Pick<TagVersion, 'major' | 'minor' | 'patch' | 'pre'>, b: Pick<TagVersion, 'major' | 'minor' | 'patch' | 'pre'>): number {
  return Math.sign(a.major - b.major) || Math.sign(a.minor - b.minor) || Math.sign(a.patch - b.patch) || comparePre(a.pre, b.pre);
}

type Op = '<' | '<=' | '>' | '>=' | '=';

interface Comparator {
  op: Op;
  v: Pick<TagVersion, 'major' | 'minor' | 'patch' | 'pre'>;
}

/** A partial version in a range: null parts are wildcards. */
interface Partial {
  major: number | null;
  minor: number | null;
  patch: number | null;
  pre: string[];
}

export class SemverRangeError extends Error {
  constructor(range: string, why: string) {
    super(`semver range "${range}" ${why}`);
    this.name = 'SemverRangeError';
  }
}

const PART = '(?:0|[1-9][0-9]*|[xX*])';
const PARTIAL_RE = new RegExp(`^v?(${PART})(?:\\.(${PART}))?(?:\\.(${PART}))?(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$`);

function parsePartial(text: string, range: string): Partial {
  const m = PARTIAL_RE.exec(text);
  if (m === null) throw new SemverRangeError(range, `has a version "${text}" it cannot read`);
  const num = (s: string | undefined): number | null => (s === undefined || /^[xX*]$/.test(s) ? null : Number(s));
  const major = num(m[1]);
  // Anything after a wildcard is a wildcard too: `1.x.3` reads as `1.x`.
  const minor = major === null ? null : num(m[2]);
  const patch = minor === null ? null : num(m[3]);
  return { major, minor, patch, pre: m[4] === undefined || patch === null ? [] : m[4].split('.') };
}

const v = (major: number, minor: number, patch: number, pre: string[] = []): Comparator['v'] => ({ major, minor, patch, pre });
/** The lowest version above every release of the given prefix: `<2.0.0-0` excludes 2.0.0's pre-releases too. */
const ceil = (major: number, minor: number, patch: number): Comparator['v'] => v(major, minor, patch, ['0']);

/** One range token (`^1.4`, `>=2`, `17.x`) as comparators that must all hold. */
function desugar(token: string, range: string): Comparator[] {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.*)$/.exec(token);
  const op = m?.[1] ?? '';
  const p = parsePartial(m?.[2] ?? '', range);
  const { major, minor, patch, pre } = p;

  if (major === null) {
    // `*`, `x`, `^*`, `>=*`: any release; `<*` and `>*` match nothing.
    return op === '<' || op === '>' ? [{ op: '<', v: v(0, 0, 0, ['0']) }] : [];
  }

  switch (op) {
    case '^': {
      const lo = v(major, minor ?? 0, patch ?? 0, pre);
      if (major > 0 || minor === null) return [{ op: '>=', v: lo }, { op: '<', v: ceil(major + 1, 0, 0) }];
      if (minor > 0 || patch === null) return [{ op: '>=', v: lo }, { op: '<', v: ceil(0, minor + 1, 0) }];
      return [{ op: '>=', v: lo }, { op: '<', v: ceil(0, 0, patch + 1) }];
    }
    case '~': {
      const lo = v(major, minor ?? 0, patch ?? 0, pre);
      if (minor === null) return [{ op: '>=', v: lo }, { op: '<', v: ceil(major + 1, 0, 0) }];
      return [{ op: '>=', v: lo }, { op: '<', v: ceil(major, minor + 1, 0) }];
    }
    case '>':
      if (minor === null) return [{ op: '>=', v: v(major + 1, 0, 0) }];
      if (patch === null) return [{ op: '>=', v: v(major, minor + 1, 0) }];
      return [{ op: '>', v: v(major, minor, patch, pre) }];
    case '>=':
      return [{ op: '>=', v: v(major, minor ?? 0, patch ?? 0, pre) }];
    case '<':
      return [{ op: '<', v: v(major, minor ?? 0, patch ?? 0, patch === null ? ['0'] : pre) }];
    case '<=':
      if (minor === null) return [{ op: '<', v: ceil(major + 1, 0, 0) }];
      if (patch === null) return [{ op: '<', v: ceil(major, minor + 1, 0) }];
      return [{ op: '<=', v: v(major, minor, patch, pre) }];
    default: {
      // Plain or `=`: an x-range when partial, an exact version when whole.
      if (minor === null) return [{ op: '>=', v: v(major, 0, 0) }, { op: '<', v: ceil(major + 1, 0, 0) }];
      if (patch === null) return [{ op: '>=', v: v(major, minor, 0) }, { op: '<', v: ceil(major, minor + 1, 0) }];
      return [{ op: '=', v: v(major, minor, patch, pre) }];
    }
  }
}

function holds(c: Comparator, x: TagVersion): boolean {
  const d = compareVersions(x, c.v);
  switch (c.op) {
    case '<':
      return d < 0;
    case '<=':
      return d <= 0;
    case '>':
      return d > 0;
    case '>=':
      return d >= 0;
    case '=':
      return d === 0;
  }
}

export interface SemverRange {
  test(version: TagVersion): boolean;
}

/** Parses a range; throws `SemverRangeError` when it cannot be read. */
export function parseSemverRange(range: string): SemverRange {
  const trimmed = range.trim();
  if (trimmed.length === 0) throw new SemverRangeError(range, 'is empty');
  const sets = trimmed.split('||').map((set) => {
    // Glue an operator to its version (`>= 1.2` → `>=1.2`), then split on whitespace.
    const tokens = set
      .trim()
      .replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1')
      .split(/\s+/)
      .filter((t) => t.length > 0);
    if (tokens.length === 0) throw new SemverRangeError(range, 'has an empty || alternative');
    return tokens.flatMap((t) => desugar(t, range));
  });
  return {
    test(version) {
      return sets.some((comparators) => {
        if (!comparators.every((c) => holds(c, version))) return false;
        if (version.pre.length === 0) return true;
        // A pre-release only when the range names one of the same release (npm's rule).
        return comparators.some(
          (c) => c.v.pre.length > 0 && c.v.pre[0] !== '0' && c.v.major === version.major && c.v.minor === version.minor && c.v.patch === version.patch,
        );
      });
    },
  };
}

/**
 * The highest tag inside `range`, or null when none is. Throws `SemverRangeError` for a range it
 * cannot read.
 */
export function pickSemverTag(tags: readonly string[], range: string): string | null {
  const parsed = parseSemverRange(range);
  let best: { tag: string; version: TagVersion } | null = null;
  for (const tag of tags) {
    const version = parseTagVersion(tag);
    if (version === null || !parsed.test(version)) continue;
    if (best === null) {
      best = { tag, version };
      continue;
    }
    const d = compareVersions(version, best.version);
    if (d > 0 || (d === 0 && (version.parts > best.version.parts || (version.parts === best.version.parts && tag < best.tag)))) {
      best = { tag, version };
    }
  }
  return best?.tag ?? null;
}
