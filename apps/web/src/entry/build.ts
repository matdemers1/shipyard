// SHP-T-9.2: the running build in the entry screens' footer, read from the public GET /api/health,
// which answers { status, schemaRevision, version } — `version` is SHIPYARD_VERSION, the image's
// 40-hex REVISION in production and 'dev' (or a harness name) anywhere else. Decorative: a failure,
// or anything that is not a commit, shows nothing.

export const HEALTH_PATH = '/api/health';

const COMMIT = /^[0-9a-f]{7,40}$/i;

/** The short revision to show, or null when the value is not a commit ('dev', 'unknown', empty, absent). */
export function buildLabel(version: unknown): string | null {
  if (typeof version !== 'string') return null;
  const value = version.trim();
  if (!COMMIT.test(value)) return null;
  return value.slice(0, 7).toLowerCase();
}

let pending: Promise<string | null> | null = null;

/**
 * The label for the server answering this page, asked once per page load: the loading state, Sign in,
 * Setup and an invite each mount the shell, and the revision does not change between them.
 */
export function fetchBuildLabel(): Promise<string | null> {
  pending ??= Promise.resolve()
    .then(() => fetch(HEALTH_PATH, { headers: { accept: 'application/json' }, credentials: 'same-origin' }))
    .then(async (res) => {
      // Anything that is not JSON (a dev server's index.html) is not a revision.
      const body = (await res.json()) as { version?: unknown } | null;
      return buildLabel(body?.version);
    })
    .catch(() => null);
  return pending;
}
