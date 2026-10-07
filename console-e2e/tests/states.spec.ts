import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  DEPLOY_SHA,
  INTERNAL_ERROR,
  alertBox,
  appRow,
  dryRunStatus,
  fakeDryRun,
  h1,
  hold,
  isPath,
  json,
  needsYou,
  needsYouRow,
} from '../harness/console.js';
import { withDb } from '../harness/db.js';
import { USERS, storageStateFor } from '../harness/env.js';
import { HOUR, MINUTE, DAY, ago, createDeploy, fixture, reseedWorld, sha, wipeAppData } from '../harness/seed.js';

/**
 * SHP-T-6.1 and SHP-T-13.14, SHP-REQ-091: every empty, loading, error and permission-denied state
 * the screen inventory lists, on the redesigned console (SHP-P-13) — one test per cell, named
 * "S<n> <state>: <what>". A "—" cell has no test.
 *
 * Loading states are observed by holding one routed request; error states the real server cannot
 * be made to produce on demand (a lost database, a dry run the absent agent never finishes) are
 * faked at the network layer with `page.route`. Everything else is the real server over the seeded
 * `_test` database — a scenario that changes the world puts the baseline back afterwards.
 */

/** A step's row on the deploy page, by the agent's name for the step (SHP-T-13.11: `data-step`). */
const stepCard = (page: Page, name: string) => page.getByRole('list', { name: 'Deploy steps' }).locator(`[data-step="${name}"]`);

/** The deploy page's verdict banner, by the start of its title (SHP-T-13.11). */
const verdict = (page: Page, title: RegExp) => page.getByRole('region', { name: title });

/** A row of Settings › Host's health checklist, by its name. */
const healthRow = (page: Page, name: string) =>
  page
    .getByRole('list', { name: 'Host health' })
    .getByRole('listitem')
    .filter({ has: page.getByText(name, { exact: true }) });

/** The held d3auth deploy's SHA (seed.ts: the approval app's second commit). */
const HELD_SHA = sha(42);

/** Apps › Needs you: "Approve and deploy <sha7>" on the held deploy opens the deploy sheet as its review. */
async function openApproval(page: Page) {
  const fx = fixture();
  await needsYouRow(page, fx.apps.approval).getByRole('button', { name: `Approve and deploy ${HELD_SHA.slice(0, 7)}` }).click();
  return page.getByRole('dialog', { name: `Approve deploy of ${fx.apps.approval} ${HELD_SHA.slice(0, 7)}` });
}

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
    await h1(page, 'Sign in');
    await expect(page.getByRole('textbox', { name: 'Email' })).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
    // Nothing offered that would lead to a refusal.
    await expect(page.getByRole('link', { name: 'Sign in with D3 Auth' })).toHaveCount(0);
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
    await h1(page, 'Apps');
    const alert = alertBox(page, 'An unexpected error occurred.');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('lost its database');
    await expect(page.getByRole('link', { name: fixture().apps.history, exact: true })).toHaveCount(0);
  });

  test('S3 empty: "Nothing to deploy — live is" the SHA asked for', async ({ page }) => {
    const fx = fixture();
    await fakeDryRun(page, dryRunStatus(fx.apps.approval, HELD_SHA, {}));
    await page.route(isPath(`/api/apps/${fx.apps.approval}/commits`), (route) =>
      json(route, 200, { live: HELD_SHA, head: HELD_SHA, commits: [], newestGreen: HELD_SHA, source: 'github' }),
    );
    await page.goto('/');
    const dialog = await openApproval(page);
    await expect(dialog.getByText(`Nothing to deploy — live is ${HELD_SHA.slice(0, 7)}.`)).toBeVisible();
  });

  test('S3 loading: a spinner while the gates are checked', async ({ page }) => {
    // The dry-run request never answers during the test: the sheet stays in "checking".
    await page.route(isPath('/api/deploys'), async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await new Promise(() => undefined);
    });
    await page.goto('/');
    const dialog = await openApproval(page);
    await expect(dialog.getByText(/Starting the checks · \d+s/)).toBeVisible();
    await expect(dialog.locator('.d3-spn')).toBeAttached();
    await expect(dialog.getByRole('button', { name: `Approve and deploy ${HELD_SHA.slice(0, 7)}` })).toBeDisabled();
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
    const dialog = await openApproval(page);
    const g5 = dialog.getByRole('listitem').filter({ hasText: 'G5' });
    await expect(g5).toContainText(/failed/i);
    await expect(g5).toContainText(reason);
    await expect(dialog.getByRole('alert').filter({ hasText: fix })).toBeVisible();
    await expect(dialog.getByRole('button', { name: `Approve and deploy ${HELD_SHA.slice(0, 7)}` })).toBeDisabled();
  });

  test('S4 loading: every planned step listed, the current step marked, finished ones with their result', async ({ page }) => {
    const id = fixture().deploys.inProgress;
    // The old live address is a redirect to the one deploy page (SHP-T-13.11).
    await page.goto(`/deploys/${id}/live`);
    await expect(page).toHaveURL(new RegExp(`/deploys/${id}$`));
    const steps = page.getByRole('list', { name: 'Deploy steps' });
    await expect(steps).toBeVisible();
    const current = steps.locator('[aria-current="step"]');
    await expect(current).toContainText('Soak');
    await expect(current).toContainText('Running');
    await expect(stepCard(page, 'pull')).toContainText('Pulled');
    await expect(verdict(page, /^Soaking/)).toBeVisible();
  });

  test('S4 error: the failed step highlighted, rollback steps after it', async ({ page }) => {
    await page.goto(`/deploys/${fixture().deploys.rolledBack}/live`);
    await expect(page.getByRole('list', { name: 'Deploy steps' })).toBeVisible();
    const check = stepCard(page, 'check');
    await expect(check).toHaveAttribute('data-state', 'failed');
    await expect(check).toContainText('exit 1');
    await expect(check).toContainText('/health: 503');
    const rollback = stepCard(page, 'rollback');
    await expect(rollback).toContainText('Roll back');
    await expect(verdict(page, /^Rolled back/)).toContainText('/health answered 503');
    // Next actions, and never a Retry.
    await expect(page.getByRole('group', { name: 'Next actions' }).getByRole('button', { name: 'Deploy again' })).toBeVisible();
    await expect(page.getByText(/\bRetry\b/)).toHaveCount(0);
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
    await expect(page.getByRole('heading', { name: /^Next up/ })).toHaveCount(0);
    held.release();
    await expect(page.getByRole('heading', { name: /^Next up/ })).toBeVisible();
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
    // The page reads the deploy from its event stream first, polling only when the stream fails.
    await page.route((url) => url.pathname === `/api/deploys/${id}` || url.pathname === `/api/deploys/${id}/events`, held.handler);
    await page.goto(`/deploys/${id}`);
    await held.seen;
    await expect(page.getByRole('status').filter({ hasText: 'Loading this deploy' })).toBeAttached();
    await expect(page.locator('[aria-busy="true"]').first()).toBeAttached();
    held.release();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Deploy /);
  });

  test('S6 error: an outbox failing badge on a deploy Foreman never received', async ({ page }) => {
    // The seeded d3auth release whose Foreman post has failed six times over three hours.
    const deployId = await withDb(async (db) => {
      // A deploy's row: build rows (SHP-T-7.15) carry no target.
      const stuck = await db.outbox.findFirstOrThrow({ where: { deliveredAt: null, targetId: { not: null } }, select: { targetId: true } });
      return (await db.deployTarget.findUniqueOrThrow({ where: { id: stuck.targetId ?? '' }, select: { deployId: true } })).deployId;
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
    await page.goto('/activity');
    await h1(page, 'Activity');
    await expect(page.locator('.shp-feed')).toBeVisible();
    await page.getByRole('button', { name: 'Load more' }).scrollIntoViewIfNeeded();
    await held.seen;
    await expect(page.getByRole('button', { name: 'Load more' })).toHaveAttribute('aria-busy', 'true');
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
      // The old /schedules address lands on Activity's schedules view (SHP-REQ-169).
      await page.goto('/schedules');
      await expect(page).toHaveURL(/\/activity\?kind=schedule$/);
      const row = page.locator('.shp-feed').getByRole('listitem').filter({ hasText: message });
      await expect(row).toBeVisible();
      // The check by its name, never its code (SHP-REQ-171).
      await expect(row).toContainText('Refused — Not frozen');
      // The row opens the deploy, which says how to fix it.
      await row.getByRole('link').click();
      await expect(page).toHaveURL(new RegExp(`/deploys/${created}$`));
      await expect(page.getByText(/Clear the freeze/).first()).toBeVisible();
    } finally {
      await withDb(async (db) => {
        await db.schedule.deleteMany({ where: { deployId: created } });
        await db.deployTarget.deleteMany({ where: { deployId: created } });
        await db.deploy.delete({ where: { id: created } });
      });
    }
  });

  test('S12 error: a fingerprint that does not match is refused', async ({ page }) => {
    // An agent awaits its fingerprint, so Host opens its enrolment (SHP-T-13.6).
    await page.goto('/settings/host');
    await h1(page, 'Host');
    await page.getByRole('textbox', { name: 'Type the fingerprint shown on the host' }).fill('SHA256:not-the-fingerprint-on-the-host');
    await page.getByRole('button', { name: 'Confirm agent' }).click();
    await expect(alertBox(page, 'The fingerprint does not match this agent.')).toBeVisible();
    // Still awaiting confirmation.
    await expect(page.getByText('Awaiting confirmation', { exact: true })).toBeVisible();
  });

  test('S12 error: the agent PAT expiring within 30 days', async ({ page }) => {
    await page.goto('/settings/host');
    const row = healthRow(page, "Agent's GitHub token");
    await expect(row).toContainText(/Expires in \d+ days/);
    await expect(row).toContainText('Replace it on the host before it does.');
    await row.getByRole('button', { name: 'Renew…' }).click();
    await expect(page.getByRole('dialog', { name: "Renew the agent's GitHub token" })).toBeVisible();
    // Apps says so too, with the way to Settings (SHP-D-089).
    await page.goto('/');
    await expect(needsYou(page).getByText('The agent’s GitHub token expires soon')).toBeVisible();
    await expect(needsYou(page).getByRole('link', { name: 'Renew in Settings' })).toHaveAttribute('href', '/settings/host');
  });

  test('S13 empty: "Just you" when no one else has an account', async ({ page }) => {
    const me = fixture().users.admin;
    await page.route(isPath('/api/users'), async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      const all = (await response.json()) as { id: string }[];
      await json(route, 200, all.filter((u) => u.id === me));
    });
    await page.goto('/settings/people');
    await expect(page.getByRole('heading', { name: 'Just you' })).toBeVisible();
  });

  test('S15 error: an outbox unsent over an hour is badged', async ({ page }) => {
    await page.goto('/settings/host');
    await h1(page, 'Host');
    await expect(healthRow(page, 'Foreman outbox')).toContainText('waited over an hour to be recorded in Foreman');
    // The Host section's own entry in the Settings sub-nav carries the warning dot.
    await expect(page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: /^Host.*needs a look/ })).toBeVisible();
    // The sidebar's host footer, visible from every screen, links to Settings › Host.
    await expect(page.getByRole('link', { name: /Host · \d+ to look at/ })).toBeVisible();
  });
});

// ── Admin, a changed world (each test puts the baseline back) ───────────

test.describe('as an admin, a changed world', () => {
  test.use({ storageState: storageStateFor('admin') });

  test.afterEach(async () => {
    await withDb((db) => reseedWorld(db));
  });

  test('S2 empty: "No agent enrolled yet" links to agent enrolment in Settings › Host', async ({ page }) => {
    await withDb((db) => wipeAppData(db));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'No agent enrolled yet' })).toBeVisible();
    await page.getByRole('link', { name: 'Enrol an agent' }).click();
    await expect(page).toHaveURL(/\/settings\/host$/);
    await h1(page, 'Host');
    await expect(healthRow(page, 'Agent')).toContainText('No agent enrolled');
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

  test('S2 error: an agent stale for over 5 minutes is in Needs you, with the way to Settings', async ({ page }) => {
    await withDb((db) => db.agent.updateMany({ where: { confirmedAt: { not: null } }, data: { lastHeartbeatAt: ago(10 * MINUTE) } }));
    await page.goto('/');
    const row = needsYou(page).getByRole('listitem').filter({ hasText: 'The agent has stopped reporting' });
    await expect(row).toContainText('live SHAs and drift may be out of date');
    await row.getByRole('link', { name: 'Open Settings' }).click();
    await h1(page, 'Host');
    await expect(healthRow(page, 'Agent')).toContainText('Not checked in since');
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
    // Confirming a restore follows it live, at the address that is also its record (SHP-T-13.11).
    await page.goto(`/deploys/${deployId}/live`);
    await expect(page).toHaveURL(new RegExp(`/deploys/${deployId}$`));
    // A restore has its own verdict (SHP-T-13.11): it names the failed step and that the data may have changed.
    const banner = verdict(page, /^Restore failed at Restore/);
    await expect(banner).toContainText('The restore step exited 1.');
    await expect(banner).toContainText('the data may have changed');
    const restore = stepCard(page, 'restore');
    await expect(restore).toHaveAttribute('data-state', 'failed');
    await expect(restore).toContainText('exit 1');
    await expect(restore.getByLabel('Output of Restore')).toContainText('pg_restore: error: could not open input file');
  });

  test('S8 empty: "No activity yet"', async ({ page }) => {
    await withDb((db) => wipeAppData(db));
    await page.goto('/activity');
    await expect(page.getByRole('heading', { name: 'No activity yet' })).toBeVisible();
  });

  test('S9 empty: nothing scheduled — the schedules view matches nothing, and offers to clear it', async ({ page }) => {
    await withDb((db) => wipeAppData(db));
    await page.goto('/activity?kind=schedule');
    await expect(page.getByRole('heading', { name: 'Nothing matches' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Upcoming deploys' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page).toHaveURL(/\/activity$/);
    await expect(page.getByRole('heading', { name: 'No activity yet' })).toBeVisible();
  });

  test('S11 empty: "No tokens yet", with the command to connect Claude Code', async ({ page }) => {
    await withDb((db) => wipeAppData(db));
    await page.goto('/settings/tokens');
    await expect(page.getByRole('heading', { name: 'No tokens yet' })).toBeVisible();
    await expect(page.getByText(/^claude mcp add .*Bearer <your token>"$/)).toBeVisible();
  });

  test('S12 empty: "No agent" links to the install runbook', async ({ page }) => {
    await withDb((db) => wipeAppData(db));
    await page.goto('/settings/host');
    await expect(healthRow(page, 'Agent')).toContainText('No agent enrolled');
    await page.getByRole('button', { name: 'Show enrolment' }).click();
    await expect(page.getByRole('heading', { name: 'No agent — see the install runbook' })).toBeVisible();
    const runbooks = page.getByRole('link', { name: 'Install runbook' });
    await expect(runbooks).toHaveCount(2);
    for (const link of await runbooks.all()) await expect(link).toHaveAttribute('href', /docs\/runbooks\/install\.md$/);
  });

  test('S12 error: the agent PAT has expired', async ({ page }) => {
    await withDb((db) => db.agent.updateMany({ where: { confirmedAt: { not: null } }, data: { patExpiresAt: ago(DAY) } }));
    await page.goto('/settings/host');
    const row = healthRow(page, "Agent's GitHub token");
    await expect(row).toContainText(/^.*Expired · /);
    await expect(row).toContainText('Deploys cannot read commit history or check runs');
    await expect(row.getByRole('button', { name: 'Renew…' })).toBeVisible();
    await page.goto('/');
    await expect(needsYou(page).getByText('The agent’s GitHub token has expired')).toBeVisible();
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
    // The row says the app is ready, and offers nothing to press.
    await expect(appRow(page, fx.apps.history)).toContainText('Ready');
    await expect(page.getByRole('button', { name: DEPLOY_SHA })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Deploy all ready/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Deploy group/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Review / })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Deny' })).toHaveCount(0);
  });

  test('S3 denied: a viewer never gets a dry-run sheet, and the server refuses one', async ({ page }) => {
    const fx = fixture();
    // No fakes: this is what the real server and console do for a viewer. The held deploy is
    // visible, but nothing that opens the sheet (Review, Deploy, Roll back) is offered…
    await page.goto('/');
    await expect(needsYouRow(page, fx.apps.approval)).toContainText(`asked to deploy ${HELD_SHA.slice(0, 7)}`);
    await expect(page.getByRole('button', { name: /^(Review|Approve)/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Deny' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Deploy/ })).toHaveCount(0);
    // …and asking the API for a dry run anyway is refused: the sheet has nothing to show.
    const res = await page.request.post('/api/deploys', { data: { kind: 'deploy', app: fx.apps.history, sha: HELD_SHA, dryRun: true } });
    expect(res.status()).toBe(403);
  });

  test('S5 denied: app detail has no actions', async ({ page }) => {
    const fx = fixture();
    await page.goto(`/apps/${fx.apps.history}`);
    await expect(page.getByRole('heading', { name: /^Next up/ })).toBeVisible();
    // The deploys are listed, and none offers a roll back; the header offers no deploy and no freeze.
    await expect(page.getByRole('list', { name: 'Deploys' }).getByRole('listitem').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Roll back to / })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Freeze', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: DEPLOY_SHA })).toHaveCount(0);
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
    await page.goto('/activity?kind=schedule');
    await h1(page, 'Activity');
    await expect(page.getByRole('list', { name: 'Upcoming deploys' }).getByRole('listitem').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Schedule a deploy' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^(Cancel|Approve) / })).toHaveCount(0);
  });

  test('S10 denied: freeze and unfreeze are hidden', async ({ page }) => {
    const fx = fixture();
    await page.goto(`/apps/${fx.apps.frozen}`);
    await expect(alertBox(page, 'Season finale this weekend: no deploys.')).toContainText(/^Frozen until/);
    await expect(page.getByRole('button', { name: 'Unfreeze', exact: true })).toHaveCount(0);
    await page.goto(`/apps/${fx.apps.history}`);
    await expect(page.getByRole('heading', { name: /^Next up/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Freeze', exact: true })).toHaveCount(0);
  });

  // The deployer-only screens became Settings sections (SHP-ADR-006). The old addresses redirect;
  // Host stays a deployer's, and the open sections show a viewer only what is theirs.
  for (const path of ['/agent', '/system', '/settings/host']) {
    test(`S12/S15 denied: ${path} is deployer-only, and the Settings sub-nav does not offer Host`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/settings\/host$/);
      await expect(page.getByRole('heading', { name: DENIED }).first()).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: /^Host/ })).toHaveCount(0);
    });
  }

  test('S11 denied: tokens are a deployer’s — a viewer is told who makes one, and sees no list', async ({ page }) => {
    await page.goto('/tokens');
    await expect(page).toHaveURL(/\/settings\/tokens$/);
    await h1(page, 'Claude & tokens');
    await expect(alertBox(page, 'A deployer makes the token')).toBeVisible();
    await expect(page.getByRole('list', { name: 'API tokens' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Make the token' })).toHaveCount(0);
  });

  test('S13 denied: users and invites are a deployer’s — a viewer sees only their own account', async ({ page }) => {
    await page.goto('/users');
    await expect(page).toHaveURL(/\/settings\/people$/);
    await h1(page, 'People');
    await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Users' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create invite' })).toHaveCount(0);
  });
});
