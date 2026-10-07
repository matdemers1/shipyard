import { expect, test } from '@playwright/test';
import { DESKTOP, PHONE, h1 } from '../harness/console.js';
import { storageStateFor } from '../harness/env.js';

/**
 * Navigation after SHP-ADR-006 (SHP-REQ-159, SHP-REQ-169), against the real built console: three
 * destinations — Apps, Activity, Settings — as a sidebar on a desktop and a tab bar on a phone, and
 * every address the old ten-item nav had still landing somewhere that makes sense.
 */

const DESTINATIONS = [/^Apps/, /^Activity/, /^Settings/];

test.describe('as an admin', () => {
  test.use({ storageState: storageStateFor('admin') });

  test.describe('at 1440 px', () => {
    test.use({ viewport: DESKTOP });

    test('the sidebar holds the three destinations, and its host line links to Settings › Host', async ({ page }) => {
      await page.goto('/');
      await h1(page, 'Apps');
      const nav = page.getByRole('navigation', { name: 'Main' });
      await expect(nav.getByRole('link')).toHaveText(DESTINATIONS);
      await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
      await nav.getByRole('link', { name: /^Activity/ }).click();
      await h1(page, 'Activity');
      await expect(nav.getByRole('link', { name: /^Activity/ })).toHaveAttribute('aria-current', 'page');
      await page.getByRole('link', { name: /^Host (healthy|· \d+ to look at)/ }).click();
      await expect(page).toHaveURL(/\/settings\/host$/);
      await h1(page, 'Host');
    });
  });

  test.describe('at 390 px', () => {
    test.use(PHONE);

    test('the tab bar holds the three destinations and moves between them without a reload', async ({ page }) => {
      await page.goto('/');
      await h1(page, 'Apps');
      const tabs = page.getByRole('navigation', { name: 'Primary' });
      await expect(tabs.getByRole('link')).toHaveText(DESTINATIONS);
      await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
      // A marker on the window survives client-side navigation and is lost by a full reload.
      await page.evaluate(() => {
        (window as unknown as { consoleE2eMarker: boolean }).consoleE2eMarker = true;
      });
      await tabs.getByRole('link', { name: /^Settings/ }).click();
      await h1(page, 'Host');
      await tabs.getByRole('link', { name: /^Activity/ }).click();
      await h1(page, 'Activity');
      expect(await page.evaluate(() => (window as unknown as { consoleE2eMarker?: boolean }).consoleE2eMarker)).toBe(true);
    });
  });

  // Every retired address and where it goes now (apps/web/src/routes.tsx, RETIRED_ROUTES).
  for (const [from, to, heading] of [
    ['/timeline', '/activity', 'Activity'],
    ['/builds', '/activity?kind=build', 'Activity'],
    ['/schedules', '/activity?kind=schedule', 'Activity'],
    ['/system', '/settings/host', 'Host'],
    ['/agent', '/settings/host', 'Host'],
    ['/tokens', '/settings/tokens', 'Claude & tokens'],
    ['/connect', '/settings/tokens', 'Claude & tokens'],
    ['/users', '/settings/people', 'People'],
    ['/account', '/settings/people', 'People'],
    ['/settings', '/settings/host', 'Host'],
    ['/timeline?app=bindery', '/activity?app=bindery', 'Activity'],
  ] as const) {
    test(`${from} lands on ${to}`, async ({ page }) => {
      await page.goto(from);
      await expect(page).toHaveURL((url) => `${url.pathname}${url.search}` === to);
      await h1(page, heading);
    });
  }
});

test.describe('as a viewer', () => {
  test.use({ storageState: storageStateFor('viewer') });

  test('Settings opens on People, where the viewer’s own account is', async ({ page }) => {
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings\/people$/);
    await h1(page, 'People');
    await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
  });
});
