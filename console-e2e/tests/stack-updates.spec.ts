import { expect, test, type Locator, type Page } from '@playwright/test';
import { axeViolations, expectTheme, forceTheme, settle, type Theme } from '../harness/a11y.js';
import { DESKTOP, PHONE, expectPhoneFit, h1, needsYou, sidewaysScroll, useWidth, type Width } from '../harness/console.js';
import { withDb } from '../harness/db.js';
import { USERS, storageStateFor } from '../harness/env.js';
import { setHostReportedAt } from '../harness/host.js';
import { fixture, reseedWorld } from '../harness/seed.js';
import { STACK_FIXTURE, seedDigestStack, seedHeldStackUpdate } from '../harness/stacks.js';

/**
 * Stack updates by digest on Host (SHP-T-16.6, SHP-ADR-010; SHP-REQ-194, SHP-REQ-199, SHP-REQ-200),
 * against the real server: the baseline's Operated stack (immich) adopted with `updates: digest`, a
 * candidate one release ahead, and a history of two successes and a rollback. At 1440 px (a panel on
 * the right) and 390 px on a touch phone (a bottom sheet), light and dark: the group header with its
 * "Update available" badge, the update sheet, the history with Roll back, a held request in Needs
 * you, and the Activity row — every state axe clean and never wider than the viewport.
 *
 * This harness runs no agent, so the server does what it really does then: an update, a rollback or
 * an approval is refused `agent_offline` at once (capabilityRefusal, SHP-T-16.3), and the console
 * shows that refusal's message and fix verbatim. A deny needs no agent and goes through.
 */

const NAME = STACK_FIXTURE.name;
const OFFLINE_MESSAGE = 'The agent that runs this has not polled the server recently.';
const OFFLINE_FIX = 'Check the agent is running and can reach the server, then retry.';

let stackId = '';

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

/** The stack's group header on Host. */
function header(page: Page): Locator {
  return page.locator('.shp-hg__head').filter({ has: page.getByRole('button', { name: NAME, exact: true }) });
}

async function openUpdateSheet(page: Page): Promise<Locator> {
  await page.goto(`/host?stack=${NAME}&update=1`);
  await expect(page.locator('h1', { hasText: 'Host' })).toBeAttached();
  const sheet = page.getByRole('dialog', { name: `Update ${NAME}` });
  await expect(sheet).toBeVisible();
  return sheet;
}

async function openHistory(page: Page): Promise<Locator> {
  await page.goto(`/host?stack=${NAME}`);
  await expect(page.locator('h1', { hasText: 'Host' })).toBeAttached();
  const sheet = page.getByRole('dialog', { name: NAME, exact: true });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('list', { name: 'Update history' })).toBeVisible();
  return sheet;
}

test.use({ storageState: storageStateFor('admin') });

test.beforeAll(async () => {
  stackId = await withDb((db) => seedDigestStack(db, fixture().agentId, USERS.admin.displayName));
});

test.beforeEach(async () => {
  await withDb((db) => setHostReportedAt(db, fixture().agentId, new Date()));
});

// The stack, its updates and anything a test asked for go; the baseline comes back.
test.afterAll(async () => {
  await withDb((db) => reseedWorld(db));
});

for (const width of ['desktop', 'phone'] as const satisfies readonly Width[]) {
  for (const theme of ['light', 'dark'] as const satisfies readonly Theme[]) {
    test.describe(`${width === 'phone' ? '390 px' : '1440 px'}, ${theme}`, () => {
      test.use(useWidth(width));

      test('the group header: Update available · running → candidate, History and Update… — axe clean', async ({ page }) => {
        await forceTheme(page, theme);
        await page.goto('/host');
        await h1(page, 'Host');
        await expectTheme(page, theme);
        const head = header(page);
        await expect(head.getByText(`Update available · ${STACK_FIXTURE.running} → ${STACK_FIXTURE.candidate}`)).toBeVisible();
        await expect(head.getByRole('button', { name: `Update… ${NAME}` })).toBeVisible();
        await expect(head.getByRole('link', { name: `History of ${NAME}` })).toBeVisible();
        await expect(head.getByRole('button', { name: `Restart stack ${NAME}` })).toBeVisible();
        await expectClean(page, `Stack group header (${theme}, ${width})`, width);
      });

      test('the update sheet: Running vs Update to, What happens, the rollback note — axe clean', async ({ page }) => {
        await forceTheme(page, theme);
        const sheet = await openUpdateSheet(page);
        await expect(sheet.getByText('Operated', { exact: true })).toBeVisible();
        const row = sheet.getByRole('row', { name: new RegExp(STACK_FIXTURE.service) });
        await expect(row.getByText(STACK_FIXTURE.running, { exact: true })).toBeVisible();
        await expect(row.getByText(STACK_FIXTURE.candidate, { exact: true })).toBeVisible();
        await expect(row.locator('code')).toHaveCount(2);
        // GET /api/stacks does not carry the manifest's backup step today, so the chain leaves Back up out.
        await expect(sheet.locator('.shp-stack-chain__chip')).toHaveText(['Re-check ^1.140', 'Pull by digest', 'Swap the image line', 'Health', 'Soak 2 min']);
        await expect(sheet.getByText(new RegExp(`^If health or the soak fails, Shipyard puts ${STACK_FIXTURE.running.replaceAll('.', '\\.')} back by its digest — images only\\.`))).toBeVisible();
        await expect(sheet.getByRole('button', { name: `Update to ${STACK_FIXTURE.candidate}` })).toBeVisible();
        await expectClean(page, `Update sheet (${theme}, ${width})`, width);

        const box = await page.locator('.shp-ssheet').boundingBox();
        if (width === 'desktop') {
          // A panel on the right, full height.
          expect(box?.y).toBe(0);
          expect(Math.round((box?.x ?? 0) + (box?.width ?? 0))).toBe(DESKTOP.width);
        } else {
          // A bottom sheet, its footer pinned to the bottom edge.
          expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(PHONE.viewport.height);
        }
      });

      test('a real update is refused agent_offline, shown verbatim — axe clean', async ({ page }) => {
        await forceTheme(page, theme);
        const sheet = await openUpdateSheet(page);
        await sheet.getByRole('button', { name: `Update to ${STACK_FIXTURE.candidate}` }).click();
        await expect(sheet.getByText(OFFLINE_MESSAGE)).toBeVisible();
        await expect(sheet.getByText(OFFLINE_FIX)).toBeVisible();
        await expectClean(page, `Update refused (${theme}, ${width})`, width);
      });

      test('the history: newest first, outcomes, who, Roll back on an earlier success — axe clean', async ({ page }) => {
        await forceTheme(page, theme);
        const sheet = await openHistory(page);
        const rows = sheet.getByRole('list', { name: 'Update history' }).getByRole('listitem');
        await expect(rows).toHaveCount(3);
        await expect(rows.nth(0).getByText('Rolled back', { exact: true })).toBeVisible();
        await expect(rows.nth(1).getByText(`v1.139.0 → ${STACK_FIXTURE.running}`)).toBeVisible();
        await expect(rows.nth(2).getByText(`claude: immich (approved by ${USERS.admin.displayName})`)).toBeVisible();
        await expect(rows.nth(0).getByRole('button')).toHaveCount(0);
        await expect(rows.nth(1).getByRole('button')).toHaveCount(0);
        await expect(rows.nth(2).getByRole('button', { name: `Roll back to ${STACK_FIXTURE.rollBackTo}` })).toBeVisible();
        await expectClean(page, `Stack history (${theme}, ${width})`, width);

        await rows.nth(2).getByRole('button', { name: `Roll back to ${STACK_FIXTURE.rollBackTo}` }).click();
        const confirm = page.getByRole('dialog', { name: `Roll back ${NAME} to ${STACK_FIXTURE.rollBackTo}?` });
        await expect(confirm).toBeVisible();
        await expectClean(page, `Roll back confirmation (${theme}, ${width})`, width);
        await confirm.getByRole('button', { name: `Roll back ${NAME} to ${STACK_FIXTURE.rollBackTo}` }).click();
        // No agent polls here: the server refuses the rollback at once, and the sheet says so verbatim.
        await expect(sheet.getByText(OFFLINE_MESSAGE)).toBeVisible();
        await expect(sheet.getByText(OFFLINE_FIX)).toBeVisible();
      });
    });
  }
}

test.describe('at 1440 px', () => {
  test.use({ viewport: DESKTOP });

  test('Update… opens the sheet with ?stack=&update=1, and Back closes it', async ({ page }) => {
    await page.goto('/host');
    await h1(page, 'Host');
    await header(page).getByRole('button', { name: `Update… ${NAME}` }).click();
    await expect(page.getByRole('dialog', { name: `Update ${NAME}` })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`[?&]stack=${NAME}&update=1`));
    await page.goBack();
    await expect(page.getByRole('dialog', { name: `Update ${NAME}` })).toHaveCount(0);
    await expect(page).toHaveURL(/\/host$/);
  });

  test('Activity lists stack updates under their own chip — axe clean', async ({ page }) => {
    await page.goto('/activity?kind=stack-update');
    await h1(page, 'Activity');
    await expect(page.getByRole('button', { name: 'Stack updates' })).toHaveAttribute('aria-pressed', 'true');
    const rows = page.locator('.shp-feed-row').filter({ hasText: NAME });
    await expect(rows).toHaveCount(3);
    const rolledBack = rows.filter({ hasText: 'Rolled back' });
    await expect(rolledBack).toContainText(STACK_FIXTURE.rolledBackMessage);
    await expect(rolledBack.getByRole('link')).toHaveAttribute('href', `/host?stack=${NAME}`);
    await settle(page);
    const { blocking } = await axeViolations(page);
    expect(blocking, blocking.join('\n')).toEqual([]);
  });
});

test.describe('a viewer', () => {
  test.use({ storageState: storageStateFor('viewer'), viewport: DESKTOP });

  test('sees the candidate and the history, and no Update…, Update to or Roll back', async ({ page }) => {
    await page.goto('/host');
    await h1(page, 'Host');
    await expect(header(page).getByText(`Update available · ${STACK_FIXTURE.running} → ${STACK_FIXTURE.candidate}`)).toBeVisible();
    await expect(header(page).getByRole('button', { name: `Update… ${NAME}` })).toHaveCount(0);
    const update = await openUpdateSheet(page);
    await expect(update.getByRole('button', { name: `Update to ${STACK_FIXTURE.candidate}` })).toHaveCount(0);
    const history = await openHistory(page);
    await expect(history.getByRole('list', { name: 'Update history' }).getByRole('button')).toHaveCount(0);
  });
});

// Last: a held request makes the stack's header say "Waiting for approval" instead of the candidate.
test.describe('Needs you', () => {
  test.beforeAll(async () => {
    await withDb((db) => seedHeldStackUpdate(db, stackId, fixture().agentId));
  });

  for (const width of ['desktop', 'phone'] as const satisfies readonly Width[]) {
    for (const theme of ['light', 'dark'] as const satisfies readonly Theme[]) {
      test.describe(`${width === 'phone' ? '390 px' : '1440 px'}, ${theme}`, () => {
        test.use(useWidth(width));

        test('a held token request with Deny and Approve and update, and the rolled-back stack — axe clean', async ({ page }) => {
          await forceTheme(page, theme);
          await page.goto('/');
          await h1(page, 'Apps');
          const rows = needsYou(page).getByRole('listitem').filter({ hasText: NAME });
          const held = rows.filter({ hasText: STACK_FIXTURE.heldRequester });
          await expect(held).toContainText(`update ${STACK_FIXTURE.running} → ${STACK_FIXTURE.candidate}`);
          await expect(held.getByRole('button', { name: `Approve and update ${NAME}` })).toBeVisible();
          await expect(held.getByRole('button', { name: `Deny the ${NAME} update` })).toBeVisible();
          const failed = rows.filter({ hasText: 'update rolled back' });
          await expect(failed).toContainText(STACK_FIXTURE.rolledBackMessage);
          await expect(failed.getByRole('link', { name: `Open ${NAME} on Host` })).toHaveAttribute('href', `/host?stack=${NAME}`);
          await expectClean(page, `Needs you with a held stack update (${theme}, ${width})`, width);
        });
      });
    }
  }

  test('Approve is refused agent_offline verbatim; Deny goes through', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/');
    await h1(page, 'Apps');
    const held = needsYou(page).getByRole('listitem').filter({ hasText: STACK_FIXTURE.heldRequester });
    await held.getByRole('button', { name: `Approve and update ${NAME}` }).click();
    await expect(page.getByText(OFFLINE_MESSAGE)).toBeVisible();
    await expect(page.getByText(OFFLINE_FIX)).toBeVisible();

    await held.getByRole('button', { name: `Deny the ${NAME} update` }).click();
    const confirm = page.getByRole('dialog', { name: `Deny the ${NAME} update` });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(needsYou(page).getByRole('listitem').filter({ hasText: STACK_FIXTURE.heldRequester })).toHaveCount(0);
  });
});
