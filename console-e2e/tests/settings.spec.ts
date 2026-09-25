import { expect, test, type Browser, type Page } from '@playwright/test';
import { clearD3AuthSetting, startFakeIssuer, type FakeIssuer } from '../harness/d3auth.js';
import { storageStateFor } from '../harness/env.js';

/**
 * S16 Settings → Sign in with D3 Auth (SHP-T-6.8, SHP-REQ-110), against the real server: an admin
 * tests an issuer, saves it with a secret, and the sign-in page offers D3 Auth at once — no restart;
 * turning it off takes the button away again. The secret never comes back to the page. A viewer is
 * refused. Password sign-in is untouched throughout (the harness's own sign-ins prove that).
 */

const SECRET = 'console-e2e-d3auth-client-secret';
const h1 = (page: Page, name: string) => expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

let fake: FakeIssuer;

test.beforeAll(async () => {
  fake = await startFakeIssuer();
  await clearD3AuthSetting();
});

test.afterAll(async () => {
  await clearD3AuthSetting();
  await fake.close();
});

/** Asserts whether a signed-out visitor is offered Sign in with D3 Auth right now. */
async function expectSignInOffersD3Auth(browser: Browser, offered: boolean): Promise<void> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const page = await context.newPage();
    // The methods call decides the button: wait for its answer, then for the render after it.
    const methods = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/auth/methods');
    await page.goto('/signin');
    const body = (await (await methods).json()) as { password: boolean; d3auth: boolean };
    expect(body).toEqual({ password: true, d3auth: offered });
    await h1(page, 'Sign in to Shipyard');
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
    const button = page.getByRole('button', { name: 'Sign in with D3 Auth' });
    if (offered) await expect(button).toBeVisible();
    else {
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      await expect(button).toHaveCount(0);
    }
  } finally {
    await context.close();
  }
}

test.describe('S16 settings as an admin', () => {
  test.use({ storageState: storageStateFor('admin') });

  test('test, save and turn off Sign in with D3 Auth — live, without a restart', async ({ page, browser }) => {
    await expectSignInOffersD3Auth(browser, false);

    await page.goto('/');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings', exact: true }).click();
    await h1(page, 'Settings');
    await expect(page.getByText('Off', { exact: true })).toBeVisible();
    await expect(page.getByText('http://127.0.0.1:').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download app manifest', exact: true })).toBeVisible();

    await page.getByRole('textbox', { name: 'Issuer' }).fill(fake.issuer);
    await page.getByRole('button', { name: 'Test', exact: true }).click();
    await expect(page.getByText('The issuer answered')).toBeVisible();

    await page.getByLabel(/^Client secret/).fill(SECRET);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await expect(page.getByText('On', { exact: true })).toBeVisible();
    await expect(page.getByText(/A secret is stored/)).toBeVisible();
    await expect(page.getByLabel(/^Client secret/)).toHaveValue('');

    // The secret is write-only: not in the page, not in what the API returns.
    await page.reload();
    await h1(page, 'Settings');
    await expect(page.getByRole('textbox', { name: 'Issuer' })).toHaveValue(fake.issuer);
    expect(await page.content()).not.toContain(SECRET);
    const read = await page.request.get('/api/settings/d3auth');
    expect(await read.text()).not.toContain(SECRET);

    // Live at once: a signed-out visitor now has the D3 Auth button.
    await expectSignInOffersD3Auth(browser, true);

    // The manifest downloads with this server's redirect URI.
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download app manifest', exact: true }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('shipyard.d3auth.json');

    await page.getByRole('button', { name: 'Turn off', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Turn off Sign in with D3 Auth?' });
    await dialog.getByRole('button', { name: 'Turn off', exact: true }).click();
    await expect(page.getByText('Turned off', { exact: true })).toBeVisible();
    await expect(page.getByText('Off', { exact: true })).toBeVisible();
    await expectSignInOffersD3Auth(browser, false);
  });

  test('an issuer that does not answer is saved, the button stays off, and the screen says why', async ({ page, browser }) => {
    await page.goto('/settings');
    await h1(page, 'Settings');
    await page.getByRole('textbox', { name: 'Issuer' }).fill('http://127.0.0.1:9');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Configured, but the D3 Auth button is off')).toBeVisible();
    await expectSignInOffersD3Auth(browser, false);
    await clearD3AuthSetting();
  });
});

test.describe('S16 settings as a viewer', () => {
  test.use({ storageState: storageStateFor('viewer') });

  test('S16 denied: Settings is admin-only', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'This page needs the admin role' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
    expect((await page.request.get('/api/settings/d3auth')).status()).toBe(403);
  });
});
