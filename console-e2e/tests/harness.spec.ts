import { expect, test } from '@playwright/test';
import { withDb } from '../harness/db.js';
import { storageStateFor } from '../harness/env.js';
import { fixture, reseedWorld, wipeAppData } from '../harness/seed.js';

/**
 * The harness's own contract, for the tests that build on it: a scenario can empty the world
 * without signing anyone out, and `reseedWorld` puts the baseline back for whatever runs next.
 */
test.describe('the harness', () => {
  test.use({ storageState: storageStateFor('admin') });

  test.afterAll(async () => {
    await withDb((db) => reseedWorld(db));
  });

  test('wipeAppData keeps the session; reseedWorld restores the baseline', async ({ page }) => {
    await withDb((db) => wipeAppData(db));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'No agent enrolled yet' })).toBeVisible();

    const fx = await withDb((db) => reseedWorld(db));
    expect(fixture().deploys.succeeded).toBe(fx.deploys.succeeded);
    await page.reload();
    await expect(page.getByRole('link', { name: fx.apps.history, exact: true })).toBeVisible();
  });
});
