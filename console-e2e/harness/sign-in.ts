import { expect, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import type { SeedUser } from './env.js';

/**
 * Signs in through the real form: email and password, then a TOTP code computed from the seeded
 * secret.
 *
 * The server spends a TOTP time step once per user (replay protection), so one user can sign in
 * at most once per 30-second step. Global setup signs each role in once and saves the browser's
 * state; tests start from that (`test.use({ storageState: storageStateFor('admin') })`) rather than
 * calling this. Call it directly only in a test *about* signing in, with a user nobody else used
 * in the same step — or pass `waitForFreshStep: true`.
 */

const PERIOD_S = 30;

export function totpFor(secret: string, timestamp: number = Date.now()): string {
  return new TOTP({ algorithm: 'SHA1', digits: 6, period: PERIOD_S, secret: Secret.fromBase32(secret) }).generate({ timestamp });
}

/** Resolves once the clock has moved into a TOTP step after `after` (ms). */
async function nextStep(after: number): Promise<void> {
  const step = Math.floor(after / 1000 / PERIOD_S);
  const wait = (step + 1) * PERIOD_S * 1000 - Date.now() + 250;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

export interface SignInOptions {
  /** Wait for the next TOTP step first — for a second sign-in by the same user in one run. */
  waitForFreshStep?: boolean;
}

export async function signIn(page: Page, user: SeedUser, options: SignInOptions = {}): Promise<void> {
  await page.goto('/signin');
  await page.getByRole('textbox', { name: 'Email' }).fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Continue' }).click();

  const codeField = page.getByText('Authenticator code');
  await expect(codeField).toBeVisible();
  if (options.waitForFreshStep === true) await nextStep(Date.now());

  await page.keyboard.type(totpFor(user.totpSecret));
  // The code input submits itself on the sixth digit; landing on Home is the proof of a session.
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
}
