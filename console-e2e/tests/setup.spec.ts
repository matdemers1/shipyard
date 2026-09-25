import { expect, test, type Page } from '@playwright/test';
import { enterZeroUserWorld, restoreAccounts, type AccountsSnapshot } from '../harness/accounts.js';
import { withDb } from '../harness/db.js';
import { BASE_URL, type SeedUser } from '../harness/env.js';
import { signIn, totpFor } from '../harness/sign-in.js';

/**
 * First-run setup in the console (SHP-T-6.7, SHP-REQ-109): on a server with no account, the first
 * visitor lands on Setup, creates an admin with a password and TOTP, and is signed in. Afterwards
 * setup is closed and the new admin signs in like anyone else.
 *
 * Runs in a zero-user world, then writes the harness's accounts and sessions back verbatim, so the
 * specs after this one still start signed in.
 */

const FIRST: SeedUser = {
  email: 'first-admin@shipyard.test',
  displayName: 'Fay First',
  password: 'console-e2e-first-admin-password',
  totpSecret: '',
  role: 'admin',
};

const h1 = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });

/** A six-digit code that is certainly wrong for `secret` right now (±1 step). */
function wrongCode(secret: string): string {
  const now = Date.now();
  const near = new Set([totpFor(secret, now), totpFor(secret, now - 30_000), totpFor(secret, now + 30_000)]);
  for (let n = 0; ; n += 1) {
    const candidate = String(n).padStart(6, '0');
    if (!near.has(candidate)) return candidate;
  }
}

async function typeCode(page: Page, code: string): Promise<void> {
  await page.getByLabel('Authenticator code').click();
  await page.keyboard.type(code);
}

test.describe('first-run setup', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ storageState: { cookies: [], origins: [] } });

  let snapshot: AccountsSnapshot | undefined;

  test.beforeAll(async () => {
    snapshot = await withDb((db) => enterZeroUserWorld(db));
  });

  test.afterAll(async () => {
    const saved = snapshot;
    if (saved !== undefined) await withDb((db) => restoreAccounts(db, saved));
  });

  test('sign-in routes a fresh install to setup, and says nothing about bootstrap-admin', async ({ page }) => {
    await page.goto('/signin');
    await expect(h1(page, 'Set up Shipyard')).toBeVisible();
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByText(/bootstrap-admin/)).toHaveCount(0);
    const status = await page.request.get('/api/setup');
    expect(await status.json()).toEqual({ available: true });
  });

  test('claims the server in the browser, lands signed in, then signs in again with password and TOTP', async ({ page, browser }) => {
    await page.goto('/');
    await expect(h1(page, 'Set up Shipyard')).toBeVisible();
    await page.getByRole('textbox', { name: 'Email' }).fill(FIRST.email);
    await page.getByRole('textbox', { name: 'Display name' }).fill(FIRST.displayName);
    await page.getByLabel('Password', { exact: true }).fill(FIRST.password);
    await page.getByLabel('Confirm password', { exact: true }).fill(FIRST.password);
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(h1(page, 'Add your authenticator')).toBeVisible();
    const secret = ((await page.getByTestId('setup-secret').textContent()) ?? '').trim();
    expect(secret).toMatch(/^[A-Z2-7]+=*$/);
    await expect(page.getByRole('link', { name: 'Add to authenticator' })).toHaveAttribute(
      'href',
      new RegExp(`^otpauth://totp/.*secret=${secret}`),
    );

    // A wrong code is refused, and nothing is created.
    await typeCode(page, wrongCode(secret));
    await expect(page.getByRole('alert')).toContainText('The authenticator code is wrong.');
    expect(await (await page.request.get('/api/setup')).json()).toEqual({ available: true });

    // The right one creates the admin and signs them in.
    await typeCode(page, totpFor(secret));
    await expect(h1(page, 'Home')).toBeVisible();
    await expect(page.locator('.shp-topline__who')).toContainText(FIRST.email);

    // Setup is closed now: the route sends a signed-in admin home, and the API says so.
    expect(await (await page.request.get('/api/setup')).json()).toEqual({ available: false });
    await page.goto('/setup');
    await expect(h1(page, 'Home')).toBeVisible();

    // A fresh browser gets sign-in, not setup, and the new admin signs in like anyone else.
    const context = await browser.newContext({ baseURL: BASE_URL });
    try {
      const fresh = await context.newPage();
      await fresh.goto('/setup');
      await expect(h1(fresh, 'Sign in to Shipyard')).toBeVisible();
      // Setup's code was never seen by sign-in's replay guard, so the current step is fine here.
      await signIn(fresh, { ...FIRST, totpSecret: secret });
    } finally {
      await context.close();
    }
  });
});
