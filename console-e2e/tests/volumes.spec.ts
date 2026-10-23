import { expect, test, type Locator, type Page } from '@playwright/test';
import { axeViolations, expectTheme, forceTheme, settle, type Theme } from '../harness/a11y.js';
import { DESKTOP, PHONE, expectPhoneFit, h1, isPath, json, needsYou, sidewaysScroll, useWidth, type Width } from '../harness/console.js';
import { withDb } from '../harness/db.js';
import { USERS, storageStateFor } from '../harness/env.js';
import { setHostReportedAt } from '../harness/host.js';
import { fixture, reseedWorld } from '../harness/seed.js';
import { nextStep, totpFor } from '../harness/sign-in.js';
import { VOLUME_FIXTURE, seedMaintenanceJobs, seedVolumeArchives } from '../harness/volumes.js';

/**
 * Volume backups, restores, orphan deletes and prune on Host (SHP-T-17.6, SHP-ADR-012 and its
 * 2026-10-23 amendment; SHP-REQ-201, SHP-REQ-202, SHP-REQ-203, SHP-REQ-205), against the real
 * server: the baseline host snapshot's owned, orphaned and Observed volumes, two archives of the
 * Deployed app's database volume in the agent's ledger, and a few finished jobs. At 1440 px (a panel
 * on the right) and 390 px on a touch phone (a bottom sheet), light and dark: the volumes list with
 * its archives, the restore, delete and prune sheets — every state axe clean and never wider than
 * the viewport.
 *
 * This harness runs no agent, so the server does what it really does then: a backup or a prune's
 * dry run is refused `agent_offline` at once (capabilityRefusal), and the console shows that
 * refusal's message and fix verbatim. Restore and delete enable only on the exact name and a
 * six-digit code; one restore steps up with the admin's real code (a fresh TOTP step) and is then
 * refused `agent_offline`. No wrong code is ever sent: failed codes count towards the admin's
 * sign-in throttle. The prune sheet's listed state needs a dry run an agent would have run: that one
 * is faked with page.route.
 */

const OFFLINE_MESSAGE = 'The agent that runs this has not polled the server recently.';
const OFFLINE_FIX = 'Check the agent is running and can reach the server, then retry.';
const OWNED = VOLUME_FIXTURE.owned;
const ORPHAN = VOLUME_FIXTURE.orphan;

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

/** A sheet is a panel on the right at 1440 px and a bottom sheet with its footer pinned at 390 px. */
async function expectSheetPlacement(page: Page, width: Width): Promise<void> {
  const box = await page.locator('.shp-vsheet').boundingBox();
  if (width === 'desktop') {
    expect(box?.y).toBe(0);
    expect(Math.round((box?.x ?? 0) + (box?.width ?? 0))).toBe(DESKTOP.width);
  } else {
    expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(PHONE.viewport.height);
  }
}

function volumeRow(page: Page, name: string): Locator {
  return page.getByRole('list', { name: 'Volumes' }).locator('.shp-hv').filter({ has: page.locator('.shp-hv__name', { hasText: new RegExp(`^${name}$`) }) });
}

async function openHost(page: Page, path = '/host'): Promise<void> {
  await page.goto(path);
  // A deep link can open a sheet at once, and the modal makes the page behind it inert — out of
  // the accessibility tree — so only wait for the heading to be there, as host-actions.spec does.
  if (path === '/host') await h1(page, 'Host');
  else await expect(page.locator('h1', { hasText: 'Host' })).toBeAttached();
}

test.use({ storageState: storageStateFor('admin') });

test.beforeAll(async () => {
  await withDb(async (db) => {
    await seedVolumeArchives(db, fixture().agentId);
    await seedMaintenanceJobs(db, fixture().agentId, USERS.admin.displayName);
  });
});

test.beforeEach(async () => {
  await withDb((db) => setHostReportedAt(db, fixture().agentId, new Date()));
});

// The archives and jobs go with the agent's rows; the baseline comes back.
test.afterAll(async () => {
  await withDb((db) => reseedWorld(db));
});

for (const width of ['desktop', 'phone'] as const satisfies readonly Width[]) {
  for (const theme of ['light', 'dark'] as const satisfies readonly Theme[]) {
    test.describe(`${width === 'phone' ? '390 px' : '1440 px'}, ${theme}`, () => {
      test.use(useWidth(width));

      test('the volumes: orphans first, Back up · Archives · Restore… on owned, Delete… on orphans, Observed untouched — axe clean', async ({ page }) => {
        await forceTheme(page, theme);
        await openHost(page);
        await expectTheme(page, theme);
        const names = page.getByRole('list', { name: 'Volumes' }).locator('.shp-hv__name');
        await expect(names.first()).toHaveText(ORPHAN);
        const owned = volumeRow(page, OWNED);
        await expect(owned.getByText('Deployed', { exact: true })).toBeVisible();
        await expect(owned.getByRole('button', { name: `Back up ${OWNED}` })).toBeVisible();
        await expect(owned.getByRole('button', { name: `Archives · 2 of ${OWNED}` })).toBeVisible();
        await expect(owned.getByRole('button', { name: `Restore… ${OWNED}` })).toBeVisible();
        const orphan = volumeRow(page, ORPHAN);
        await expect(orphan.getByText('Orphaned', { exact: true })).toBeVisible();
        await expect(orphan.getByRole('button')).toHaveText(['Delete…']);
        await expect(page.getByRole('button', { name: 'Prune…' })).toBeVisible();
        await expectClean(page, `Volumes (${theme}, ${width})`, width);

        // Every volume: the Observed one says it is left alone.
        await page.getByRole('button', { name: /^Show all \d+$/ }).click();
        const observed = volumeRow(page, VOLUME_FIXTURE.observed);
        await expect(observed.getByText('Observed — no actions')).toBeVisible();
        await expect(observed.getByRole('button')).toHaveCount(0);

        // The archives, newest first, linked by ?volume=.
        await owned.getByRole('button', { name: `Archives · 2 of ${OWNED}` }).click();
        await expect(page).toHaveURL(new RegExp(`[?&]volume=${OWNED}`));
        const archives = owned.getByRole('list', { name: `Archives · 2 of ${OWNED}` }).getByRole('listitem');
        await expect(archives).toHaveCount(2);
        await expect(archives.nth(0).getByText('Quiesced')).toBeVisible();
        await expect(archives.nth(1).getByText('Live copy')).toBeVisible();
        await expectClean(page, `Volume archives (${theme}, ${width})`, width);
      });

      test('a backup is refused agent_offline, shown verbatim on the row — axe clean', async ({ page }) => {
        await forceTheme(page, theme);
        await openHost(page);
        const owned = volumeRow(page, OWNED);
        await owned.getByRole('button', { name: `Back up ${OWNED}` }).click();
        const confirm = page.getByRole('dialog', { name: `Back up ${OWNED}?` });
        await expect(confirm).toBeVisible();
        await expectClean(page, `Back up confirmation (${theme}, ${width})`, width);
        await confirm.getByRole('button', { name: 'Back up', exact: true }).click();
        await expect(owned.getByText(OFFLINE_MESSAGE)).toBeVisible();
        await expect(owned.getByText(OFFLINE_FIX)).toBeVisible();
        await expectClean(page, `Backup refused (${theme}, ${width})`, width);
      });

      test('the restore sheet: what is replaced, the chain, the archives, the typed name and the code — axe clean', async ({ page }) => {
        await forceTheme(page, theme);
        await openHost(page, `/host?volume=${OWNED}&restore=${VOLUME_FIXTURE.olderArchive}`);
        const sheet = page.getByRole('dialog', { name: `Restore ${OWNED}` });
        await expect(sheet).toBeVisible();
        await expect(sheet.getByText('The volume’s current contents are replaced')).toBeVisible();
        await expect(sheet.locator('.shp-stack-chain__chip').first()).toHaveText(/^Stop bindery \(\d+ containers?\)$/);
        await expect(sheet.locator('.shp-stack-chain__chip').last()).toHaveText('Health');
        const radios = sheet.getByRole('radio');
        await expect(radios).toHaveCount(2);
        await expect(radios.nth(1)).toBeChecked();
        await expect(sheet.getByLabel('Authenticator code')).toBeVisible();
        const go = sheet.getByRole('button', { name: `Restore ${OWNED}` });
        await expect(go).toBeDisabled();
        await expectClean(page, `Restore sheet (${theme}, ${width})`, width);
        await expectSheetPlacement(page, width);

        await sheet.getByLabel(`Type ${OWNED} to confirm`).fill(OWNED);
        await expect(sheet.getByText('Matches the volume name')).toBeVisible();
        // The name alone is not enough: the step-up code comes first (SHP-ADR-012 amendment).
        await expect(go).toBeDisabled();
        await sheet.getByLabel('Authenticator code').fill('123456');
        await expect(go).toBeEnabled();
        await expectClean(page, `Restore ready (${theme}, ${width})`, width);
      });

      test('the delete sheet: the facts, that it cannot be undone, the typed name and step-up — axe clean', async ({ page }) => {
        await forceTheme(page, theme);
        await openHost(page, `/host?volume=${ORPHAN}&delete=1`);
        const sheet = page.getByRole('dialog', { name: `Delete ${ORPHAN}` });
        await expect(sheet).toBeVisible();
        await expect(sheet.getByText('This cannot be undone')).toBeVisible();
        await expect(sheet.getByText('No container, running or stopped')).toBeVisible();
        await expect(sheet.getByText(/refuses with volume_in_use and deletes nothing/)).toBeVisible();
        await expectClean(page, `Delete sheet (${theme}, ${width})`, width);
        await expectSheetPlacement(page, width);

        const go = sheet.getByRole('button', { name: `Delete ${ORPHAN}` });
        await sheet.getByLabel(`Type ${ORPHAN} to confirm`).fill(ORPHAN);
        await expect(go).toBeDisabled();
        await sheet.getByLabel('Authenticator code').fill('123456');
        await expect(go).toBeEnabled();
        await expectClean(page, `Delete ready (${theme}, ${width})`, width);
      });

      test('the prune sheet: the dry run is refused agent_offline verbatim — axe clean', async ({ page }) => {
        await forceTheme(page, theme);
        await openHost(page);
        await page.getByRole('button', { name: 'Prune…' }).click();
        await expect(page).toHaveURL(/[?&]prune=1/);
        const sheet = page.getByRole('dialog', { name: 'Prune images and build cache' });
        await expect(sheet.getByText(OFFLINE_MESSAGE)).toBeVisible();
        await expect(sheet.getByText(OFFLINE_FIX)).toBeVisible();
        await expect(sheet.getByRole('button', { name: 'Prune these' })).toBeDisabled();
        await expectClean(page, `Prune refused (${theme}, ${width})`, width);
        await expectSheetPlacement(page, width);
      });

      test('the prune sheet with a dry run’s list, grouped, and Prune these — axe clean', async ({ page }) => {
        await forceTheme(page, theme);
        const DRY = '7d1c1f6e-6a4e-4d43-9a49-8e1f2b3c4d11';
        const MB = 1024 * 1024;
        const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
        const status = {
          id: DRY,
          kind: 'prune',
          state: 'succeeded',
          step: 'listing',
          volume: null,
          owner: null,
          requester: { kind: 'user', label: `${USERS.admin.displayName} (console)` },
          createdAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          archive: null,
          removedArchives: [],
          prune: {
            items: [
              { kind: 'image', id: `sha256:1c9e4f${'0'.repeat(54)}07ab`, ref: null, sizeBytes: 612 * MB, createdAt: days(12), reason: 'dangling' },
              { kind: 'image', id: `sha256:${'3'.repeat(64)}`, ref: 'ghcr.io/matdemers1/bindery/worker:sha-5d1c2e0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', sizeBytes: 540 * MB, createdAt: days(21), reason: 'unused' },
              { kind: 'build-cache', id: 'k3v9x2q81mtd', ref: null, sizeBytes: 310 * MB, createdAt: days(9), reason: 'old-cache' },
            ],
            reclaimableBytes: 1462 * MB,
            reclaimedBytes: null,
          },
          refusal: null,
          output: null,
        };
        await page.route(isPath('/api/prune'), (route) => json(route, 202, { ...status, state: 'queued', finishedAt: null, prune: null }));
        await page.route(isPath(`/api/maintenance/${DRY}`), (route) => json(route, 200, status));
        await openHost(page, '/host?prune=1');
        const sheet = page.getByRole('dialog', { name: 'Prune images and build cache' });
        await expect(sheet.getByText('1.4 GB back')).toBeVisible();
        await expect(sheet.getByRole('heading', { name: 'Dangling images' })).toBeVisible();
        await expect(sheet.getByRole('heading', { name: 'Unused images, older than 7 days' })).toBeVisible();
        await expect(sheet.getByRole('heading', { name: 'Build cache, older than 7 days' })).toBeVisible();
        await expect(sheet.getByText('Volumes are never pruned. Delete orphaned volumes one at a time from their row.')).toBeVisible();
        await expect(sheet.getByRole('button', { name: 'Prune these' })).toBeEnabled();
        await expectClean(page, `Prune dry run (${theme}, ${width})`, width);
      });
    });
  }
}

test.describe('at 1440 px', () => {
  test.use({ viewport: DESKTOP });

  test('Restore… opens the sheet on the newest archive with ?volume=&restore=, and Back closes it', async ({ page }) => {
    await openHost(page);
    await volumeRow(page, OWNED).getByRole('button', { name: `Restore… ${OWNED}` }).click();
    await expect(page.getByRole('dialog', { name: `Restore ${OWNED}` })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`[?&]volume=${OWNED}&restore=${VOLUME_FIXTURE.newestArchive}`));
    await expect(page.getByRole('dialog', { name: `Restore ${OWNED}` }).getByRole('radio').first()).toBeChecked();
    await page.goBack();
    await expect(page.getByRole('dialog', { name: `Restore ${OWNED}` })).toHaveCount(0);
    await expect(page).toHaveURL(/\/host$/);
  });

  test('a restore steps up with a real code first, then the server refuses it agent_offline, verbatim', async ({ page }) => {
    await openHost(page, `/host?volume=${OWNED}&restore=${VOLUME_FIXTURE.newestArchive}`);
    const sheet = page.getByRole('dialog', { name: `Restore ${OWNED}` });
    await expect(sheet.getByRole('radio').first()).toBeChecked();
    await sheet.getByLabel(`Type ${OWNED} to confirm`).fill(OWNED);
    // A code is spent once per step: wait for one nobody has used.
    await nextStep(Date.now());
    await sheet.getByLabel('Authenticator code').fill(totpFor(USERS.admin.totpSecret));
    await sheet.getByRole('button', { name: `Restore ${OWNED}` }).click();
    // Past the step-up and every check before the agent: with no agent polling, agent_offline.
    await expect(sheet.getByText(OFFLINE_MESSAGE)).toBeVisible();
    await expect(sheet.getByText(OFFLINE_FIX)).toBeVisible();
  });

  test('Activity lists maintenance under its own chip — axe clean', async ({ page }) => {
    await page.goto('/activity?kind=maintenance');
    await h1(page, 'Activity');
    await expect(page.getByRole('button', { name: 'Maintenance' })).toHaveAttribute('aria-pressed', 'true');
    const backedUp = page.locator('.shp-feed-row').filter({ hasText: 'Backed up' });
    await expect(backedUp).toContainText(OWNED);
    await expect(backedUp.getByRole('link')).toHaveAttribute('href', `/host?volume=${OWNED}`);
    await expect(page.locator('.shp-feed-row').filter({ hasText: 'Pruned' })).toContainText('Freed 3.1 GB');
    const refused = page.locator('.shp-feed-row').filter({ hasText: 'Delete · Refused' });
    await expect(refused).toContainText(VOLUME_FIXTURE.deleteRefusedMessage);
    await expect(refused).toContainText(VOLUME_FIXTURE.deleteRefusedFix);
    await settle(page);
    const { blocking } = await axeViolations(page);
    expect(blocking, blocking.join('\n')).toEqual([]);
  });

  test('Needs you lists the refused nightly backup verbatim, linking to the volume', async ({ page }) => {
    await page.goto('/');
    await h1(page, 'Apps');
    const row = needsYou(page).getByRole('listitem').filter({ hasText: 'foreman_pgdata' });
    await expect(row).toContainText(`backup refused — ${VOLUME_FIXTURE.failedBackupMessage}`);
    await expect(row).toContainText(VOLUME_FIXTURE.failedBackupFix);
    await expect(row.getByRole('link', { name: 'Open foreman_pgdata on Host' })).toHaveAttribute('href', '/host?volume=foreman_pgdata');
  });
});

test.describe('a viewer', () => {
  test.use({ storageState: storageStateFor('viewer'), viewport: DESKTOP });

  test('sees every volume and its archives, and no Back up, Restore…, Delete… or Prune…', async ({ page }) => {
    await openHost(page);
    const owned = volumeRow(page, OWNED);
    await expect(owned.getByRole('button')).toHaveText(['Archives · 2']);
    await expect(volumeRow(page, ORPHAN).getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Prune…' })).toHaveCount(0);
  });
});
