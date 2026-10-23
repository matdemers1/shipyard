import { expect, test, type Locator, type Page } from '@playwright/test';
import { axeViolations, expectTheme, forceTheme, settle, type Theme } from '../harness/a11y.js';
import { DESKTOP, PHONE, expectPhoneFit, h1, isPath, json, sidewaysScroll, useWidth, type Width } from '../harness/console.js';
import { withDb } from '../harness/db.js';
import { storageStateFor } from '../harness/env.js';
import { HOST_FIXTURE, hostInventory, setHostReportedAt } from '../harness/host.js';
import { fixture, reseedWorld } from '../harness/seed.js';

/**
 * A container's sheet on Host (SHP-T-15.7, SHP-REQ-184/185/188/189/192, SHP-ADR-010/011), against
 * the real server and the seeded snapshot: opened from a row or by `?container=`, at 1440 px (a
 * panel on the right) and 390 px on a touch phone (a bottom sheet), in light and dark — axe clean
 * and never wider than the viewport.
 *
 * This harness runs no agent. So a real lifecycle action stays queued (the test asserts exactly
 * that), a finished one is faked with `page.route`, and the logs viewer meets the server's refusal
 * — no agent that streams logs — which must render as a clean state, not a spinner.
 */

const WORKER = 'bindery-worker-1';
const OBSERVED = 'forgejo';

/** The seeded containers' IDs, the way harness/host.ts derives them. */
function containerId(name: string): string {
  const found = hostInventory(Date.now()).containers.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no seeded container ${name}`);
  return found.id;
}

const FAKE_ACTION = '0b9c1f6e-6a4e-4d43-9a49-8e1f2b3c4d5e';

function actionStatus(overrides: Record<string, unknown>): Record<string, unknown> {
  const now = Date.now();
  return {
    id: FAKE_ACTION,
    target: { kind: 'app', name: HOST_FIXTURE.deployedApp },
    verb: 'restart',
    service: 'worker',
    state: 'queued',
    requesterLabel: 'Matthew Demers (console)',
    createdAt: new Date(now - 9_000).toISOString(),
    startedAt: null,
    endedAt: null,
    refusal: null,
    output: null,
    ...overrides,
  };
}

/** Answers the sheet's action POST with a fake action, and its poll with `polled`. */
async function fakeAction(page: Page, polled: Record<string, unknown>): Promise<void> {
  await page.route(isPath('/api/actions'), async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    return json(route, 202, actionStatus({}));
  });
  await page.route(isPath(`/api/actions/${FAKE_ACTION}`), (route) => json(route, 200, polled));
}

async function openSheet(page: Page, name = WORKER): Promise<Locator> {
  await page.goto(`/host?container=${containerId(name)}`);
  await h1(page, 'Host');
  const sheet = page.getByRole('dialog', { name });
  await expect(sheet).toBeVisible();
  return sheet;
}

/** The logs section has settled: no agent streams logs here, so it shows the refusal, not a spinner. */
async function logsSettled(sheet: Locator): Promise<void> {
  const logs = sheet.locator('.shp-logs');
  await expect(logs.getByText('Loading logs')).toHaveCount(0, { timeout: 15_000 });
  await expect(logs.locator('.shp-logs__state, .d3-alrt').first()).toBeVisible();
}

async function expectClean(page: Page, label: string, width: Width): Promise<void> {
  await settle(page);
  const { blocking } = await axeViolations(page);
  expect(blocking, `${label}:\n  ${blocking.join('\n  ')}`).toEqual([]);
  const { overflow, culprits } = await sidewaysScroll(page);
  expect(overflow, `${label} scrolls sideways:\n  ${culprits.join('\n  ')}`).toBeLessThanOrEqual(0);
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(widths.scroll, label).toBe(widths.client);
  if (width === 'phone') await expectPhoneFit(page, label);
}

test.use({ storageState: storageStateFor('admin') });

test.beforeEach(async () => {
  await withDb((db) => setHostReportedAt(db, fixture().agentId, new Date()));
});

// A real action leaves a queued row behind; put the baseline back for the specs after this one.
test.afterAll(async () => {
  await withDb((db) => reseedWorld(db));
});

for (const width of ['desktop', 'phone'] as const satisfies readonly Width[]) {
  for (const theme of ['light', 'dark'] as const satisfies readonly Theme[]) {
    test.describe(`${width === 'phone' ? '390 px' : '1440 px'}, ${theme}`, () => {
      test.use(useWidth(width));

      test('the sheet: facts, actions, logs state and the redaction note — axe clean, no sideways scroll', async ({ page }) => {
        await forceTheme(page, theme);
        const sheet = await openSheet(page);
        await expectTheme(page, theme);
        await expect(sheet.getByText('Deployed', { exact: true })).toBeVisible();
        await expect(sheet.getByRole('group', { name: 'Actions' }).getByRole('button')).toHaveText(['Restart', 'Recreate', 'Stop']);
        await expect(sheet.getByText('last 200 lines')).toBeVisible();
        await expect(sheet.getByText(/^Redacted on the host before they leave it, and never stored\. Opening these logs is recorded in the audit log\.$/)).toBeVisible();
        await logsSettled(sheet);
        await expectClean(page, `Container sheet (${theme}, ${width})`, width);

        if (width === 'desktop') {
          // A panel on the right, full height, the list still beside it.
          const box = await page.locator('.shp-csheet').boundingBox();
          expect(box?.y).toBe(0);
          expect(Math.round((box?.x ?? 0) + (box?.width ?? 0))).toBe(DESKTOP.width);
        } else {
          // A bottom sheet: its bottom edge on the viewport's.
          const box = await page.locator('.shp-csheet').boundingBox();
          expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(PHONE.viewport.height);
        }
      });

      test('Stop asks first, and says stop is console-only — axe clean', async ({ page }) => {
        await forceTheme(page, theme);
        const sheet = await openSheet(page);
        await sheet.getByRole('button', { name: 'Stop', exact: true }).click();
        const confirm = page.getByRole('dialog', { name: `Stop ${WORKER}?` });
        await expect(confirm).toBeVisible();
        await expect(confirm.getByText('Stop is console-only: a Claude session can restart or recreate, never stop.')).toBeVisible();
        await expect(confirm.getByRole('button', { name: `Stop ${WORKER}` })).toBeVisible();
        await expectClean(page, `Stop confirmation (${theme}, ${width})`, width);
        await confirm.getByRole('button', { name: 'Cancel' }).click();
        await expect(confirm).toHaveCount(0);
      });

      test('a finished action shows its result inline — axe clean', async ({ page }) => {
        const startedAt = new Date(Date.now() - 8_000).toISOString();
        await fakeAction(page, actionStatus({ state: 'succeeded', startedAt, endedAt: new Date(Date.parse(startedAt) + 8_000).toISOString(), output: 'Container bindery-worker-1  Restarted' }));
        await forceTheme(page, theme);
        const sheet = await openSheet(page);
        await sheet.getByRole('button', { name: 'Restart', exact: true }).click();
        await expect(sheet.getByText('Restarted worker in 8s')).toBeVisible();
        await logsSettled(sheet);
        await expectClean(page, `Action result (${theme}, ${width})`, width);
      });
    });
  }
}

test.describe('at 1440 px', () => {
  test.use({ viewport: DESKTOP });

  test('a row opens the sheet with ?container=, and Back closes it', async ({ page }) => {
    await page.goto('/host');
    await h1(page, 'Host');
    await page.getByRole('button', { name: HOST_FIXTURE.deployedProject, exact: true }).click();
    await page.getByRole('link', { name: WORKER, exact: true }).click();
    await expect(page.getByRole('dialog', { name: WORKER })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`[?&]container=${containerId(WORKER)}`));
    await page.goBack();
    await expect(page.getByRole('dialog', { name: WORKER })).toHaveCount(0);
    await expect(page).toHaveURL(/\/host$/);
  });

  test('an Observed container offers no action (SHP-REQ-185)', async ({ page }) => {
    const sheet = await openSheet(page, OBSERVED);
    await expect(sheet.getByRole('group', { name: 'Actions' })).toHaveCount(0);
    await expect(sheet.getByText(/^Observed: Shipyard only watches this container/)).toBeVisible();
    await logsSettled(sheet);
  });

  test('a real restart is queued — no agent takes it here — with the buttons held', async ({ page }) => {
    const sheet = await openSheet(page);
    await sheet.getByRole('button', { name: 'Restart', exact: true }).click();
    const banner = sheet.locator('.shp-action-banner');
    await expect(banner).toBeVisible();
    await expect(banner.locator('.shp-action-banner__head')).toHaveText('Queued');
    await expect(banner).toContainText('waiting for the agent to pick it up');
    for (const name of ['Restart', 'Recreate', 'Stop']) await expect(sheet.getByRole('button', { name, exact: true })).toBeDisabled();
  });

  test("a refusal shows the server's message and fix verbatim", async ({ page }) => {
    await page.route(isPath('/api/actions'), (route) =>
      route.request().method() === 'POST'
        ? json(route, 409, { error: { code: 'locked', gate: 'G4', message: 'bindery is being deployed by Matthew Demers (console).', fix: 'Wait for that deploy to finish, then try again.' } })
        : route.fallback(),
    );
    const sheet = await openSheet(page);
    await sheet.getByRole('button', { name: 'Recreate', exact: true }).click();
    await expect(sheet.getByText('bindery is being deployed by Matthew Demers (console).')).toBeVisible();
    await expect(sheet.getByText('Wait for that deploy to finish, then try again.')).toBeVisible();
  });

  test('a Deployed group restarts its stack; an Observed group offers nothing', async ({ page }) => {
    await fakeAction(page, actionStatus({ service: null, state: 'running', startedAt: new Date().toISOString() }));
    await page.goto('/host');
    await h1(page, 'Host');
    const groups = page.getByRole('list', { name: 'Compose projects' });
    await expect(groups.getByRole('button', { name: `Restart stack ${HOST_FIXTURE.observedProject}` })).toHaveCount(0);
    await groups.getByRole('button', { name: `Restart stack ${HOST_FIXTURE.deployedProject}` }).click();
    await expect(groups.locator('.shp-action-banner__head')).toHaveText('Restarting');
    const { blocking } = await axeViolations(page);
    expect(blocking, blocking.join('\n')).toEqual([]);
  });

  test("the app page's containers link to their sheet on Host", async ({ page }) => {
    await page.goto(`/apps/${HOST_FIXTURE.deployedApp}`);
    await h1(page, HOST_FIXTURE.deployedApp);
    await page.getByRole('tab', { name: 'Config' }).click();
    await page.getByRole('link', { name: /Logs and actions for worker/ }).click();
    await expect(page).toHaveURL(new RegExp(`/host\\?container=${containerId(WORKER)}$`));
    await expect(page.getByRole('dialog', { name: WORKER })).toBeVisible();
  });

  test('Activity lists an action with its own chip — axe clean', async ({ page }) => {
    await page.route(isPath('/api/actions'), (route) =>
      route.request().method() === 'GET'
        ? json(route, 200, {
            items: [actionStatus({ state: 'succeeded', startedAt: new Date(Date.now() - 9_000).toISOString(), endedAt: new Date(Date.now() - 1_000).toISOString() })],
            nextCursor: null,
          })
        : route.fallback(),
    );
    await page.goto('/activity?kind=action');
    await h1(page, 'Activity');
    await expect(page.getByRole('button', { name: 'Actions' })).toHaveAttribute('aria-pressed', 'true');
    const row = page.locator('.shp-feed-row').filter({ hasText: 'Restarted' });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(HOST_FIXTURE.deployedApp);
    await expect(row).toContainText('worker · done in 8s');
    await settle(page);
    const { blocking } = await axeViolations(page);
    expect(blocking, blocking.join('\n')).toEqual([]);
  });
});

test.describe('at 390 px', () => {
  test.use(PHONE);

  test('the sheet opens from a row as a bottom sheet and fits', async ({ page }) => {
    await page.goto('/host');
    await h1(page, 'Host');
    await page.getByRole('button', { name: HOST_FIXTURE.deployedProject, exact: true }).click();
    await page.getByRole('link', { name: WORKER, exact: true }).click();
    const sheet = page.getByRole('dialog', { name: WORKER });
    await expect(sheet).toBeVisible();
    await logsSettled(sheet);
    await settle(page);
    await expectPhoneFit(page, 'Container sheet from a row (390 px)');
  });
});
