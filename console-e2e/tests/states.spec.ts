import { createHash } from 'node:crypto';
import { expect, test, type Page, type Route } from '@playwright/test';
import { withDb } from '../harness/db.js';
import { USERS, storageStateFor } from '../harness/env.js';
import { HOUR, MINUTE, DAY, ago, createDeploy, fixture, reseedWorld, sha, wipeAppData } from '../harness/seed.js';

/**
 * SHP-T-6.1, SHP-REQ-091: every empty, loading, error and permission-denied state the screen
 * inventory lists, one test per cell, named "S<n> <state>: <what>". A "—" cell has no test.
 *
 * Loading states are observed by holding one routed request; error states the real server cannot
 * be made to produce on demand (a lost database, a dry run the absent agent never finishes) are
 * faked at the network layer with `page.route`. Everything else is the real server over the seeded
 * `_test` database — a scenario that changes the world puts the baseline back afterwards.
 */

// ── Helpers ─────────────────────────────────────────────────────────────

const h1 = (page: Page, name: string | RegExp) => expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

/** The home card for `app`. */
const card = (page: Page, app: string) => page.getByRole('listitem').filter({ has: page.getByRole('link', { name: app, exact: true }) });

/** A step's card on the progress screen, by the step's name. */
const stepCard = (page: Page, name: string) =>
  page.getByRole('list', { name: 'Deploy steps' }).getByRole('listitem').filter({ has: page.locator('strong').getByText(name, { exact: true }) });

/** A route handler that holds the request until `release()` is called (then lets it through). */
function hold(): { handler: (route: Route) => Promise<void>; release: () => void; seen: Promise<void> } {
  let release: () => void = () => undefined;
  let markSeen: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = new Promise<void>((resolve) => {
    markSeen = resolve;
  });
  return {
    handler: async (route) => {
      markSeen();
      await gate;
      await route.continue().catch(() => undefined);
    },
    release: () => {
      release();
    },
    seen,
  };
}

const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Exactly the server's generic 500 (apps/server/src/errors.ts) — what a lost database answers. */
const INTERNAL_ERROR = {
  error: { code: 'internal_error', gate: 'none', message: 'An unexpected error occurred.', fix: 'Try again; if this persists, contact an operator.' },
};

/**
 * An Alert by its text. A static `@d3cloud/ui` Alert has no role (only a `dynamic` one is a live
 * region), so it is found by the design system's class.
 */
const alertBox = (page: Page, text: string) => page.locator('.d3-alrt').filter({ hasText: text });

const isPath = (path: string) => (url: URL) => url.pathname === path;

// ── The dry-run sheet's fakes (no agent runs a dry run in this harness) ──

const FAKE_DRY_RUN = 'console-e2e-fake-dry-run';

/** Answers the sheet's dry-run POST with a fake deploy ID, and its poll with `status`. */
async function fakeDryRun(page: Page, status: Record<string, unknown> | null): Promise<void> {
  await page.route(isPath('/api/deploys'), async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    return json(route, 202, { deployId: FAKE_DRY_RUN, state: 'queued' });
  });
  if (status !== null) {
    await page.route(isPath(`/api/deploys/${FAKE_DRY_RUN}`), (route) => json(route, 200, status));
  }
}

function dryRunStatus(app: string, at: string, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    deployId: FAKE_DRY_RUN,
    kind: 'deploy',
    app,
    sha: at,
    dryRun: true,
    state: 'succeeded',
    currentStep: null,
    requester: { label: USERS.admin.displayName, repo: null, branch: null },
    images: [],
    schemaRevision: null,
    refusal: null,
    gates: ['G1', 'G2', 'G3', 'G4', 'G5'].map((gate) => ({ gate, pass: true, reason: 'ok' })),
    createdAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** The held d3auth deploy's SHA (seed.ts: the approval app's second commit). */
const HELD_SHA = sha(42);

// ── S1 Sign in (signed out) ─────────────────────────────────────────────

test.describe('S1 sign in', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('S1 loading: the Continue button spins while the password is checked', async ({ page }) => {
    const held = hold();
    await page.route(isPath('/api/auth/login'), held.handler);
    await page.goto('/signin');
    await page.getByRole('textbox', { name: 'Email' }).fill('nobody@shipyard.test');
    await page.getByLabel('Password', { exact: true }).fill('not-a-real-password');
    await page.getByRole('button', { name: 'Continue' }).click();
    await held.seen;
    await expect(page.getByRole('button', { name: 'Continue' })).toHaveAttribute('aria-busy', 'true');
    held.release();
    await expect(page.getByRole('button', { name: 'Continue' })).not.toHaveAttribute('aria-busy', 'true');
  });

  test('S1 error: wrong credentials are refused with what to do next', async ({ page }) => {
    await page.goto('/signin');
    await page.getByRole('textbox', { name: 'Email' }).fill('nobody@shipyard.test');
    await page.getByLabel('Password', { exact: true }).fill('not-a-real-password');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(alertBox(page, 'The email or password is wrong.')).toBeVisible();
    await expect(page.getByText('Check both and try again.')).toBeVisible();
    // Still on the password step: nothing moved on to the authenticator code.
    await expect(page.getByText('Authenticator code')).toHaveCount(0);
  });

  test('S1 error: D3 Auth unreachable, the app-native form is still offered', async ({ page }) => {
    await page.route(isPath('/api/auth/methods'), (route) => route.abort('connectionrefused'));
    await page.goto('/signin');
    await h1(page, 'Sign in to Shipyard');
    await expect(page.getByRole('textbox', { name: 'Email' })).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
    // Nothing offered that would lead to a refusal.
    await expect(page.getByRole('button', { name: 'Sign in with D3 Auth' })).toHaveCount(0);
  });
});

// ── Admin, baseline world (read-only) ───────────────────────────────────

test.describe('as an admin, baseline world', () => {
  test.use({ storageState: storageStateFor('admin') });

  test('S2 loading: skeleton cards while the apps are read', async ({ page }) => {
    const held = hold();
    await page.route(isPath('/api/apps'), held.handler);
    await page.goto('/');
    await held.seen;
    await expect(page.getByRole('status').filter({ hasText: 'Loading apps' })).toBeAttached();
    await expect(page.getByRole('link', { name: fixture().apps.history, exact: true })).toHaveCount(0);
    held.release();
    await expect(page.getByRole('link', { name: fixture().apps.history, exact: true })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Loading apps' })).toHaveCount(0);
  });

  test("S2 error: the server can't reach its database", async ({ page }) => {
    await page.route(isPath('/api/apps'), (route) => json(route, 500, INTERNAL_ERROR));
    await page.goto('/');
    await h1(page, 'Home');
    const alert = alertBox(page, 'An unexpected error occurred.');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('lost its database');
    await expect(page.getByRole('link', { name: fixture().apps.history, exact: true })).toHaveCount(0);
  });

  test('S3 empty: "Nothing to ship — live is" the SHA asked for', async ({ page }) => {
    const fx = fixture();
    await fakeDryRun(page, dryRunStatus(fx.apps.approval, HELD_SHA, {}));
    await page.route(isPath(`/api/apps/${fx.apps.approval}/commits`), (route) =>
      json(route, 200, { live: HELD_SHA, head: HELD_SHA, commits: [], newestGreen: HELD_SHA, source: 'github' }),
    );
    await page.goto('/');
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `Approve deploy of ${fx.apps.approval}` });
    await expect(dialog.getByText(`Nothing to ship — live is ${HELD_SHA.slice(0, 7)}.`)).toBeVisible();
  });

  test('S3 loading: a spinner while the gates are checked', async ({ page }) => {
    const fx = fixture();
    // The dry-run request never answers during the test: the sheet stays in "checking".
    await page.route(isPath('/api/deploys'), async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await new Promise(() => undefined);
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `Approve deploy of ${fx.apps.approval}` });
    await expect(dialog.getByText('Checking gates…')).toBeVisible();
    await expect(dialog.locator('.d3-spn')).toBeAttached();
    await expect(dialog.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('S3 error: each failed gate is named with its fix', async ({ page }) => {
    const fx = fixture();
    const reason = `The image workflow for ${HELD_SHA.slice(0, 7)} has not succeeded (it is failure).`;
    const fix = 'Wait for the image workflow to succeed for this SHA.';
    await fakeDryRun(
      page,
      dryRunStatus(fx.apps.approval, HELD_SHA, {
        state: 'refused',
        gates: [
          { gate: 'G1', pass: true, reason: 'ok' },
          { gate: 'G5', pass: false, reason },
        ],
        refusal: { code: 'ci_not_green', gate: 'G5', message: reason, fix },
      }),
    );
    await page.goto('/');
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `Approve deploy of ${fx.apps.approval}` });
    const g5 = dialog.getByRole('listitem').filter({ hasText: 'G5' });
    await expect(g5).toContainText('failed');
    await expect(g5).toContainText(reason);
    await expect(dialog.getByRole('alert').filter({ hasText: fix })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  });

  test('S4 loading: the step list with live output, the current step marked', async ({ page }) => {
    await page.goto(`/deploys/${fixture().deploys.inProgress}/live`);
    const steps = page.getByRole('list', { name: 'Deploy steps' });
    await expect(steps).toBeVisible();
    const current = steps.locator('[aria-current="step"]');
    await expect(current).toContainText('soak');
    await expect(current).toContainText('Running');
    await expect(steps.getByLabel('Output of pull')).toContainText('Pulled');
  });

  test('S4 error: the failed step highlighted, rollback steps after it', async ({ page }) => {
    await page.goto(`/deploys/${fixture().deploys.rolledBack}/live`);
    await expect(page.getByRole('list', { name: 'Deploy steps' })).toBeVisible();
    const check = stepCard(page, 'check');
    await expect(check).toContainText('Failed (exit 1)');
    await expect(check).toContainText('/health: 503');
    const rollback = stepCard(page, 'rollback');
    await expect(rollback).toContainText('Rollback');
    await expect(alertBox(page, 'Rolled back')).toContainText('/health answered 503');
  });

  test('S5 empty: "Never deployed through Shipyard" with adopt-live', async ({ page }) => {
    await page.goto(`/apps/${fixture().apps.neverDeployed}`);
    await expect(page.getByRole('heading', { name: 'Never deployed through Shipyard' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Adopt what’s running' }).or(page.getByRole('button', { name: "Adopt what's running" }))).toBeVisible();
  });

  test('S5 loading: a skeleton while the app is read', async ({ page }) => {
    const app = fixture().apps.history;
    const held = hold();
    await page.route(isPath(`/api/apps/${app}`), held.handler);
    await page.goto(`/apps/${app}`);
    await held.seen;
    await expect(page.getByRole('status').filter({ hasText: `Loading ${app}` })).toBeAttached();
    await expect(page.locator('[aria-busy="true"]').first()).toBeAttached();
    await expect(page.getByRole('heading', { name: 'Manifest' })).toHaveCount(0);
    held.release();
    await expect(page.getByRole('heading', { name: 'Manifest' })).toBeVisible();
  });

  test('S5 error: the drift banner says deploys are blocked', async ({ page }) => {
    const app = fixture().apps.drifted;
    await page.goto(`/apps/${app}`);
    const banner = alertBox(page, `${app} is running something other than its recorded release`);
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('New deploys are refused');
  });

  test('S6 loading: a skeleton while the deploy is read', async ({ page }) => {
    const id = fixture().deploys.succeeded;
    const held = hold();
    await page.route(isPath(`/api/deploys/${id}`), held.handler);
    await page.goto(`/deploys/${id}`);
    await held.seen;
    await expect(page.getByRole('status').filter({ hasText: 'Loading this deploy' })).toBeAttached();
    await expect(page.locator('[aria-busy="true"]').first()).toBeAttached();
    held.release();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('·');
  });

  test('S6 error: an outbox failing badge on a deploy Foreman never received', async ({ page }) => {
    // The seeded d3auth release whose Foreman post has failed six times over three hours.
    const deployId = await withDb(async (db) => {
      const stuck = await db.outbox.findFirstOrThrow({ where: { deliveredAt: null }, select: { targetId: true } });
      return (await db.deployTarget.findUniqueOrThrow({ where: { id: stuck.targetId }, select: { deployId: true } })).deployId;
    });
    await page.goto(`/deploys/${deployId}`);
    await expect(page.getByText('Outbox failing')).toBeVisible();
    await expect(page.getByText('A post has been unsent for over an hour.')).toBeVisible();
  });

  test('S7 empty: "No backups recorded for this app"', async ({ page }) => {
    await page.goto(`/apps/${fixture().apps.neverDeployed}/restore`);
    await expect(page.getByRole('heading', { name: 'No backups recorded for this app' })).toBeVisible();
  });

  test('S8 loading: the next page loads as the list scrolls', async ({ page }) => {
    // The baseline fits one page: say there is another, and hold it.
    await page.route(
      (url) => url.pathname === '/api/deploys/timeline' && !url.searchParams.has('cursor'),
      async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as { items: unknown[] };
        await json(route, 200, { ...body, nextCursor: 'console-e2e-next-page' });
      },
    );
    const held = hold();
    await page.route((url) => url.pathname === '/api/deploys/timeline' && url.searchParams.get('cursor') === 'console-e2e-next-page', async (route) => {
      await held.handler(route).catch(() => undefined);
    });
    await page.goto('/timeline');
    await h1(page, 'Timeline');
    await expect(page.getByRole('list', { name: 'Deploys' })).toBeVisible();
    await page.getByRole('button', { name: /^(Load more|Loading…)$/ }).scrollIntoViewIfNeeded();
    await held.seen;
    await expect(page.getByRole('button', { name: 'Loading…' })).toBeDisabled();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('S9 error: a schedule refused when it fired shows the reason', async ({ page }) => {
    // Added in-test and removed after: the baseline's fired schedule succeeded.
    const fx = fixture();
    const message = 'sceptrefall is frozen: Season finale this weekend: no deploys.';
    const created = await withDb(async (db) => {
      const app = await db.app.findUniqueOrThrow({ where: { name: fx.apps.frozen }, select: { id: true } });
      const refused = await createDeploy(db, {
        appId: app.id,
        appName: fx.apps.frozen,
        services: ['server'],
        sha: sha(32),
        state: 'refused',
        endedAt: ago(2 * HOUR),
        requesterLabel: USERS.admin.displayName,
        requesterUserId: fx.users.admin,
        refusal: { code: 'app_frozen', gate: 'G2', message, fix: 'Clear the freeze or wait for it to lift, then schedule it again.' },
      });
      await db.schedule.create({ data: { deployId: refused.deployId, fireAt: ago(2 * HOUR), firedAt: ago(2 * HOUR), byUserId: fx.users.admin } });
      return refused.deployId;
    });
    try {
      await page.goto('/schedules');
      const past = page.getByRole('list', { name: 'Fired and cancelled deploys' });
      const row = past.getByRole('listitem').filter({ hasText: message });
      await expect(row).toBeVisible();
      await expect(row).toContainText('Clear the freeze');
    } finally {
      await withDb(async (db) => {
        await db.schedule.deleteMany({ where: { deployId: created } });
        await db.deployTarget.deleteMany({ where: { deployId: created } });
        await db.deploy.delete({ where: { id: created } });
      });
    }
  });

  test('S12 error: a fingerprint that does not match is refused', async ({ page }) => {
    await page.goto('/agent');
    await h1(page, 'Agent');
    await page.getByRole('textbox', { name: 'Type the fingerprint shown on the host' }).fill('SHA256:not-the-fingerprint-on-the-host');
    await page.getByRole('button', { name: 'Confirm agent' }).click();
    await expect(alertBox(page, 'The fingerprint does not match this agent.')).toBeVisible();
    // Still awaiting confirmation.
    await expect(page.getByText('Awaiting confirmation')).toBeVisible();
  });

  test('S12 error: the agent PAT expiring within 30 days', async ({ page }) => {
    await page.goto('/agent');
    await expect(alertBox(page, "The agent's GitHub token expires within 30 days")).toBeVisible();
    await expect(page.getByText('Expiring', { exact: true })).toBeVisible();
  });

  test('S13 empty: "Just you" when no one else has an account', async ({ page }) => {
    const me = fixture().users.admin;
    await page.route(isPath('/api/users'), async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      const all = (await response.json()) as { id: string }[];
      await json(route, 200, all.filter((u) => u.id === me));
    });
    await page.goto('/users');
    await expect(page.getByRole('heading', { name: 'Just you' })).toBeVisible();
  });

  test('S15 error: an outbox unsent over an hour is badged', async ({ page }) => {
    await page.goto('/system');
    await h1(page, 'System');
    await expect(alertBox(page, 'Deploys not yet recorded in Foreman')).toBeVisible();
    // The nav badge, visible from every screen.
    await expect(page.getByRole('link', { name: /^System, \d+ needing attention$/ })).toBeVisible();
  });
});

// ── Admin, a changed world (each test puts the baseline back) ───────────

test.describe('as an admin, a changed world', () => {
  test.use({ storageState: storageStateFor('admin') });

  test.afterEach(async () => {
    await withDb((db) => reseedWorld(db));
  });

  test('S2 empty: "No agent enrolled yet" links to the agent screen', async ({ page }) => {
    await withDb((db) => wipeAppData(db));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'No agent enrolled yet' })).toBeVisible();
    await page.getByRole('link', { name: 'Enrol an agent' }).click();
    await h1(page, 'Agent');
  });

  test('S2 empty: "Agent reported no apps" links to the onboarding runbook', async ({ page }) => {
    await withDb(async (db) => {
      await wipeAppData(db);
      await db.agent.create({
        data: {
          publicKey: 'MCowBQYDK2VwAyEAconsoleE2eLonelyAgentPublicKey00000000000000=',
          fingerprint: 'SHA256:c0ns0le-e2e-l0nely-agent-f1ngerpr1nt',
          enrolledAt: ago(DAY),
          confirmedAt: ago(DAY),
          lastHeartbeatAt: new Date(),
        },
      });
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Agent reported no apps' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Onboarding runbook' })).toHaveAttribute('href', /docs\/runbooks\/onboard-app\.md$/);
  });

  test('S2 error: an agent stale for over 5 minutes shows a banner', async ({ page }) => {
    await withDb((db) => db.agent.updateMany({ where: { confirmedAt: { not: null } }, data: { lastHeartbeatAt: ago(10 * MINUTE) } }));
    await page.goto('/');
    await expect(alertBox(page, 'No agent has reported recently')).toBeVisible();
  });

  test('S7 error: a failed restore command is in the journal', async ({ page }) => {
    const fx = fixture();
    const deployId = await withDb(async (db) => {
      const app = await db.app.findUniqueOrThrow({ where: { name: fx.apps.history }, select: { id: true } });
      const failed = await createDeploy(db, {
        appId: app.id,
        appName: fx.apps.history,
        services: ['server', 'worker'],
        sha: sha(2),
        kind: 'restore',
        state: 'failed',
        endedAt: ago(HOUR),
        requesterLabel: USERS.admin.displayName,
        requesterUserId: fx.users.admin,
        images: false,
        refusal: { code: 'step_failed', gate: 'none', message: 'The restore step exited 1.', fix: "Read the step's journaled output and fix the step before retrying." },
        steps: [
          { name: 'backup', argv: ['docker', 'compose', '-p', 'bindery', 'run', '--rm', 'backup'], exitCode: 0, output: 'safety dump written' },
          { name: 'restore', argv: ['docker', 'compose', '-p', 'bindery', 'run', '--rm', 'restore'], exitCode: 1, output: 'pg_restore: error: could not open input file' },
        ],
      });
      return failed.deployId;
    });
    // Confirming a restore follows it live; the record keeps the journal.
    await page.goto(`/deploys/${deployId}/live`);
    await expect(alertBox(page, 'Failed')).toContainText('The restore step exited 1.');
    await expect(stepCard(page, 'restore')).toContainText('Failed (exit 1)');
    await page.getByRole('link', { name: 'Deploy record' }).click();
    const journal = page.getByRole('region', { name: 'Journal' }).or(page.locator('section').filter({ has: page.getByRole('heading', { name: 'Journal' }) }));
    await expect(journal.first()).toContainText('exit 1');
    await expect(journal.first()).toContainText('pg_restore: error: could not open input file');
  });

  test('S8 empty: "No deploys yet"', async ({ page }) => {
    await withDb((db) => wipeAppData(db));
    await page.goto('/timeline');
    await expect(page.getByRole('heading', { name: 'No deploys yet' })).toBeVisible();
  });

  test('S9 empty: "Nothing scheduled"', async ({ page }) => {
    await withDb((db) => wipeAppData(db));
    await page.goto('/schedules');
    await expect(page.getByRole('heading', { name: 'Nothing scheduled' })).toBeVisible();
  });

  test('S11 empty: "No tokens — create one per repo" with the config snippet', async ({ page }) => {
    await withDb((db) => wipeAppData(db));
    await page.goto('/tokens');
    await expect(page.getByRole('heading', { name: 'No tokens — create one per repo' })).toBeVisible();
    await expect(page.getByText('"mcpServers"')).toBeVisible();
    await expect(page.getByText('Bearer <token>')).toBeVisible();
  });

  test('S12 empty: "No agent" links to the install runbook', async ({ page }) => {
    await withDb((db) => wipeAppData(db));
    await page.goto('/agent');
    await expect(page.getByRole('heading', { name: 'No agent — see the install runbook' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Install runbook' })).toHaveAttribute('href', /docs\/runbooks\/install\.md$/);
  });

  test('S12 error: the agent PAT has expired', async ({ page }) => {
    await withDb((db) => db.agent.updateMany({ where: { confirmedAt: { not: null } }, data: { patExpiresAt: ago(DAY) } }));
    await page.goto('/agent');
    await expect(alertBox(page, "The agent's GitHub token has expired")).toBeVisible();
    await expect(page.getByText('Expired', { exact: true })).toBeVisible();
  });

  test('S13 error: an expired invite link says so', async ({ page }) => {
    const token = `inv_${'consoleE2eExpiredInvite'.padEnd(43, '0')}`;
    await withDb((db) =>
      db.invite.create({
        data: {
          email: 'too-late@shipyard.test',
          role: 'viewer',
          tokenHash: createHash('sha256').update(token).digest('hex'),
          invitedById: fixture().users.admin,
          createdAt: ago(9 * DAY),
          expiresAt: ago(2 * DAY),
        },
      }),
    );
    await page.goto(`/invite/${token}`);
    await expect(alertBox(page, 'This invite has expired.')).toBeVisible();
    await expect(page.getByText('Ask whoever invited you for a new one.')).toBeVisible();
  });
});

// ── Viewer: what is hidden, read-only or denied ─────────────────────────

test.describe('as a viewer', () => {
  test.use({ storageState: storageStateFor('viewer') });

  const DENIED = 'This page needs the deployer role';

  test('S2 denied: deploy buttons are hidden', async ({ page }) => {
    const fx = fixture();
    await page.goto('/');
    await expect(page.getByRole('link', { name: fx.apps.history, exact: true })).toBeVisible();
    await expect(card(page, fx.apps.history)).toContainText('waiting');
    await expect(page.getByRole('button', { name: /^Ship / })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^(Up to date|Nothing green)$/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Deploy group' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Deny' })).toHaveCount(0);
  });

  test('S3 denied: a viewer never gets a dry-run sheet, and the server refuses one', async ({ page }) => {
    const fx = fixture();
    // No fakes: this is what the real server and console do for a viewer. The held deploy is
    // visible, but nothing that opens the sheet (Review, Deploy, Roll back) is offered…
    await page.goto('/');
    await expect(page.getByText(fx.apps.approval, { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Review', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Deny' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Deploy/ })).toHaveCount(0);
    // …and asking the API for a dry run anyway is refused: the sheet has nothing to show.
    const res = await page.request.post('/api/deploys', { data: { kind: 'deploy', app: fx.apps.history, sha: HELD_SHA, dryRun: true } });
    expect(res.status()).toBe(403);
  });

  test('S5 denied: app detail has no actions', async ({ page }) => {
    const fx = fixture();
    await page.goto(`/apps/${fx.apps.history}`);
    await expect(page.getByRole('heading', { name: 'Manifest' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Rollback targets' }).getByRole('listitem').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Roll back to / })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Freeze', exact: true })).toHaveCount(0);
    // Drift and never-deployed: seen, not acted on.
    await page.goto(`/apps/${fx.apps.drifted}`);
    await expect(page.getByText('Your role is viewer: a deployer resolves drift.')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Adopt what/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Redeploy recorded release' })).toHaveCount(0);
  });

  test('S7 denied: restore is hidden', async ({ page }) => {
    const fx = fixture();
    await page.goto(`/apps/${fx.apps.history}/restore`);
    await h1(page, `Restore ${fx.apps.history}`);
    await expect(page.getByRole('list', { name: 'Backups' }).getByRole('listitem').first()).toBeVisible();
    await expect(page.getByText('Your role can read backups but not restore them.')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Restore/ })).toHaveCount(0);
  });

  test('S9 denied: schedules are read-only', async ({ page }) => {
    await page.goto('/schedules');
    await h1(page, 'Schedules');
    await expect(page.getByRole('list', { name: 'Upcoming deploys' }).getByRole('listitem').first()).toBeVisible();
    await expect(page.getByText('Your role can read schedules but not change them.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Schedule a deploy' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^(Cancel|Approve) / })).toHaveCount(0);
  });

  test('S10 denied: freeze and unfreeze are hidden', async ({ page }) => {
    const fx = fixture();
    await page.goto(`/apps/${fx.apps.frozen}`);
    await expect(alertBox(page, `${fx.apps.frozen} is frozen`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Unfreeze', exact: true })).toHaveCount(0);
    await page.goto(`/apps/${fx.apps.history}`);
    await expect(page.getByRole('heading', { name: 'Manifest' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Freeze', exact: true })).toHaveCount(0);
  });

  for (const [n, path, label] of [
    ['S11', '/tokens', 'API tokens'],
    ['S12', '/agent', 'Agent'],
    ['S13', '/users', 'Users'],
    ['S15', '/system', 'System'],
  ] as const) {
    test(`${n} denied: ${label} is deployer-only`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: DENIED })).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(0);
      // And the nav does not offer it.
      await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: label, exact: true })).toHaveCount(0);
    });
  }
});
