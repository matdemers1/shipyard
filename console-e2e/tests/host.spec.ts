import { expect, test, type Page } from '@playwright/test';
import { axeViolations, expectTheme, forceTheme, settle, type Theme } from '../harness/a11y.js';
import { DESKTOP, PHONE, expectPhoneFit, h1, sidewaysScroll, useWidth, type Width } from '../harness/console.js';
import { withDb } from '../harness/db.js';
import { storageStateFor } from '../harness/env.js';
import { HOST_FIXTURE, seedHostSnapshot, setHostReportedAt } from '../harness/host.js';
import { fixture } from '../harness/seed.js';

/**
 * Host (SHP-T-14.7, SHP-REQ-178, SHP-REQ-181), against the real server and the seeded snapshot
 * (harness/host.ts): the fourth destination at 1440 px and at 390 px on a touch phone, in light and
 * dark — axe clean, and the document never wider than the viewport. It shows containers grouped by
 * compose project and tier, a Deployed group linking to its app page, volumes, images and disk, the
 * snapshot's age (stale after two report intervals), keeps the filter in the address, and sends
 * nothing but reads.
 */

/** The seeded snapshot reported just now, so the page is not stale unless a test makes it so. */
async function freshSnapshot(): Promise<void> {
  await withDb((db) => setHostReportedAt(db, fixture().agentId, new Date()));
}

async function openHost(page: Page, path = '/host'): Promise<void> {
  await page.goto(path);
  await h1(page, 'Host');
  await expect(page.getByRole('list', { name: 'Compose projects' })).toBeVisible();
  await settle(page);
}

/** Every request the page sends that is not a read (SHP-REQ-181). */
function trackWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && request.url().includes('/api/')) writes.push(`${request.method()} ${request.url()}`);
  });
  return writes;
}

test.use({ storageState: storageStateFor('admin') });

test.beforeEach(async () => {
  await freshSnapshot();
});

for (const width of ['desktop', 'phone'] as const satisfies readonly Width[]) {
  for (const theme of ['light', 'dark'] as const satisfies readonly Theme[]) {
    test.describe(`${width === 'phone' ? '390 px' : '1440 px'}, ${theme}`, () => {
      test.use(useWidth(width));

      test('Host is axe clean and no wider than the viewport, with a group open', async ({ page }) => {
        await forceTheme(page, theme);
        await openHost(page);
        await expectTheme(page, theme);
        // Open a Deployed group too, so its rows (image, sparkline, use) are checked as well.
        await page.getByRole('button', { name: HOST_FIXTURE.deployedProject, exact: true }).click();
        await expect(page.getByRole('list', { name: `${HOST_FIXTURE.deployedProject} containers` })).toBeVisible();
        await settle(page);

        const label = `Host (${theme}, ${width})`;
        const { blocking } = await axeViolations(page);
        expect(blocking, `${label}:\n  ${blocking.join('\n  ')}`).toEqual([]);
        const { overflow, culprits } = await sidewaysScroll(page);
        expect(overflow, `${label} scrolls sideways:\n  ${culprits.join('\n  ')}`).toBeLessThanOrEqual(0);
        const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
        expect(widths.scroll).toBe(widths.client);
        if (width === 'phone') await expectPhoneFit(page, label);
      });

      test('Host is axe clean when the snapshot is stale', async ({ page }) => {
        await withDb((db) => setHostReportedAt(db, fixture().agentId, new Date(Date.now() - 10 * 60_000)));
        await forceTheme(page, theme);
        await openHost(page);
        await expect(page.getByText(/^Last reported 10 min ago — the agent may be down\.$/)).toBeVisible();
        const { blocking } = await axeViolations(page);
        expect(blocking, blocking.join('\n')).toEqual([]);
        if (width === 'phone') await expectPhoneFit(page, `Host stale (${theme}, ${width})`);
      });
    });
  }
}

test.describe('at 1440 px', () => {
  test.use({ viewport: DESKTOP });

  test('shows the snapshot: age, tiles, groups by tier, volumes, images — and only reads', async ({ page }) => {
    const writes = trackWrites(page);
    await openHost(page);
    await expect(page.getByText(/^Everything Docker runs on this host, read-only\. Reported \d+ (s|min) ago\.$/)).toBeVisible();
    await expect(page.getByText('Agent reporting')).toBeVisible();

    const tiles = page.getByRole('group', { name: 'Host summary' });
    await expect(tiles).toContainText(`${String(HOST_FIXTURE.containers - HOST_FIXTURE.notRunning)} running · ${String(HOST_FIXTURE.notRunning)} not running`);
    await expect(tiles).toContainText(`${String(HOST_FIXTURE.orphaned)} orphaned`);
    await expect(tiles).toContainText('on /DATA');
    await expect(tiles).toContainText('build cache');

    const groups = page.getByRole('list', { name: 'Compose projects' });
    // Deployed (alphabetical), then Operated, then Observed, then the containers compose did not create.
    await expect(groups.locator('.shp-hg__toggle')).toHaveText(['bindery', 'foreman', HOST_FIXTURE.operatedProject, HOST_FIXTURE.observedProject, 'Not in a compose project']);
    // Only the group with a container that is not running opens by default.
    await expect(page.getByRole('list', { name: `${HOST_FIXTURE.observedProject} containers` })).toContainText(HOST_FIXTURE.exitedContainer);
    await expect(page.getByRole('list', { name: `${HOST_FIXTURE.deployedProject} containers` })).toHaveCount(0);

    await page.getByRole('button', { name: HOST_FIXTURE.deployedProject, exact: true }).click();
    const rows = page.getByRole('list', { name: `${HOST_FIXTURE.deployedProject} containers` });
    await expect(rows.getByRole('listitem')).toHaveCount(3);
    await expect(rows.getByText('Running · healthy').first()).toBeVisible();
    await expect(rows.getByRole('img', { name: /^CPU over the last 6 reports/ }).first()).toBeVisible();

    const volumes = page.getByRole('list', { name: 'Volumes' });
    await expect(volumes.getByRole('listitem')).toHaveCount(6);
    await expect(volumes.getByRole('listitem').first()).toContainText('Orphaned');
    await page.getByRole('button', { name: `Show all ${String(HOST_FIXTURE.volumes)}` }).click();
    await expect(volumes.getByRole('listitem')).toHaveCount(HOST_FIXTURE.volumes);

    await expect(page.getByText(/^10 images · .* · 2 not used by any container .* · 1 untagged$/)).toBeVisible();
    await expect(page.getByText(/^Read-only\. Deployed is a D3 app Shipyard deploys/)).toBeVisible();

    // A Deployed group links to its app page.
    await page.getByRole('link', { name: `Open app ${HOST_FIXTURE.deployedApp}` }).click();
    await expect(page).toHaveURL(new RegExp(`/apps/${HOST_FIXTURE.deployedApp}$`));
    await h1(page, HOST_FIXTURE.deployedApp);
    expect(writes).toEqual([]);
  });

  test('the filter chips live in the address', async ({ page }) => {
    await openHost(page, '/host?tier=deployed');
    const chips = page.getByRole('group', { name: 'Filter containers' });
    await expect(chips.getByRole('button', { name: /^Deployed \d+$/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('list', { name: 'Compose projects' }).locator('.shp-hg__toggle')).toHaveText(['bindery', 'foreman']);
    await chips.getByRole('button', { name: /^Not running \d+$/ }).click();
    await expect(page).toHaveURL(/\/host\?state=not-running$/);
    await expect(page.getByRole('list', { name: 'Compose projects' }).locator('.shp-hg__toggle')).toHaveText([HOST_FIXTURE.observedProject]);
    await page.reload();
    await expect(chips.getByRole('button', { name: /^Not running \d+$/ })).toHaveAttribute('aria-pressed', 'true');
  });

  test('says so when no agent has reported an inventory', async ({ page }) => {
    const agentId = fixture().agentId;
    await withDb(async (db) => {
      await db.hostSample.deleteMany({ where: { agentId } });
      await db.hostSnapshot.deleteMany({ where: { agentId } });
    });
    try {
      await page.goto('/host');
      await h1(page, 'Host');
      await expect(page.getByRole('heading', { name: 'No host inventory yet' })).toBeVisible();
      const { blocking } = await axeViolations(page);
      expect(blocking, blocking.join('\n')).toEqual([]);
    } finally {
      await withDb((db) => seedHostSnapshot(db, agentId));
    }
  });
});

test.describe('at 390 px', () => {
  test.use(PHONE);

  test('Host is the third tab, current on /host, and its chips scroll inside their own row', async ({ page }) => {
    await openHost(page);
    const tabs = page.getByRole('navigation', { name: 'Primary' });
    // The Apps tab carries its Needs-you count before its label on a phone ("3Apps").
    await expect(tabs.getByRole('link')).toHaveText([/Apps$/, /^Activity/, /^Host/, /^Settings/]);
    await expect(tabs.getByRole('link', { name: /^Host/ })).toHaveAttribute('aria-current', 'page');
    const chips = page.getByRole('group', { name: 'Filter containers' });
    const box = await chips.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(PHONE.viewport.width);
    await expectPhoneFit(page, 'Host');
  });
});
