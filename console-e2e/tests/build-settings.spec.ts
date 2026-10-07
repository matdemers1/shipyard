import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { axeViolations, expectTheme, forceTheme, settle, type Theme } from '../harness/a11y.js';
import { withDb } from '../harness/db.js';
import { storageStateFor } from '../harness/env.js';
import { fixture } from '../harness/seed.js';
import { fingerprintOf, signingString } from '../../packages/schema/src/index.js';

/**
 * SHP-T-7.11, SHP-REQ-131/132/133 — against the real server:
 *
 * - Settings → Builds: an admin edits the CPU, memory and cache-cap limits and saves them; they
 *   persist across a reload.
 * - The System screen's build cache: "not yet reported" before any agent has, then the size, cap,
 *   last GC time and applied limits once an agent reports one — axe-clean in light and dark, at
 *   375 px and at desktop width.
 *
 * No agent runs in this harness (see builds.spec.ts). The seeded confirmed agent's key pair is a
 * placeholder with no matching private key, so proving the real, signed report path needs a real
 * key: this file temporarily re-keys that agent row to one it holds the private half of, posts one
 * signed `/api/agent/report`, and restores the seeded placeholder afterwards.
 */

const h1 = (page: Page, name: string | RegExp) => expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

interface Key {
  privateKey: KeyObject;
  b64: string;
  fingerprint: string;
}

function makeKey(): Key {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const raw = Buffer.from(der.subarray(der.length - 32));
  return { privateKey, b64: raw.toString('base64'), fingerprint: fingerprintOf(raw) };
}

function signedHeaders(key: Key, method: string, path: string, body: string): Record<string, string> {
  const timestamp = String(Date.now());
  const nonce = randomBytes(16).toString('base64url');
  const data = signingString({ method, path, timestamp, nonce, body: Buffer.from(body, 'utf8') });
  return {
    'x-shipyard-key': key.fingerprint,
    'x-shipyard-timestamp': timestamp,
    'x-shipyard-nonce': nonce,
    'x-shipyard-signature': sign(null, Buffer.from(data, 'utf8'), key.privateKey).toString('base64'),
    'content-type': 'application/json',
  };
}

/** Restores the seeded confirmed agent's placeholder key, so every other spec sees what it expects. */
async function restoreSeededAgentKey(): Promise<void> {
  await withDb((db) =>
    db.agent.update({
      where: { id: fixture().agentId },
      data: {
        publicKey: 'MCowBQYDK2VwAyEAconsoleE2eConfirmedAgentPublicKey0000000000=',
        fingerprint: 'SHA256:c0ns0le-e2e-c0nf1rmed-agent-f1ngerpr1nt',
      },
    }),
  );
}

async function axeCleanAt(page: Page, url: string, theme: Theme, phone: boolean): Promise<void> {
  await forceTheme(page, theme);
  if (phone) await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(url);
  await h1(page, 'System');
  await expectTheme(page, theme);
  await settle(page);
  const { blocking } = await axeViolations(page);
  expect(blocking, blocking.join('\n')).toEqual([]);
}

test.afterAll(async () => {
  await restoreSeededAgentKey();
});

test.describe('S16 settings → Builds as an admin', () => {
  test.use({ storageState: storageStateFor('admin') });

  test('edit and save the CPU, memory and cache-cap limits; they persist across a reload', async ({ page }) => {
    await page.goto('/settings/builds');
    await h1(page, 'Settings');

    const form = page.getByRole('form', { name: 'Builds' });
    await expect(form.getByRole('spinbutton', { name: 'CPUs' })).toHaveValue('2');
    await expect(form.getByRole('spinbutton', { name: /^Memory/ })).toHaveValue('4096');
    await expect(form.getByRole('spinbutton', { name: /^Cache cap/ })).toHaveValue('20');

    await form.getByRole('spinbutton', { name: 'CPUs' }).fill('4');
    await form.getByRole('spinbutton', { name: /^Memory/ }).fill('8192');
    await form.getByRole('spinbutton', { name: /^Cache cap/ }).fill('50');
    await page.getByRole('button', { name: 'Save build limits', exact: true }).click();
    await expect(page.getByText('Build limits saved', { exact: true })).toBeVisible();

    await page.reload();
    await h1(page, 'Settings');
    const reloaded = page.getByRole('form', { name: 'Builds' });
    await expect(reloaded.getByRole('spinbutton', { name: 'CPUs' })).toHaveValue('4');
    await expect(reloaded.getByRole('spinbutton', { name: /^Memory/ })).toHaveValue('8192');
    await expect(reloaded.getByRole('spinbutton', { name: /^Cache cap/ })).toHaveValue('50');

    const read = await page.request.get('/api/settings/builds');
    expect(await read.json()).toEqual({ cpus: 4, memoryMb: 8192, cacheCapGb: 50 });
  });

  test('a CPU value that is not a half-CPU step disables Save', async ({ page }) => {
    await page.goto('/settings/builds');
    await h1(page, 'Settings');
    const form = page.getByRole('form', { name: 'Builds' });
    await form.getByRole('spinbutton', { name: 'CPUs' }).fill('1.3');
    await expect(page.getByRole('button', { name: 'Save build limits', exact: true })).toBeDisabled();
  });
});

test.describe('S16 settings → Builds as a viewer', () => {
  test.use({ storageState: storageStateFor('viewer') });

  test('denied: admin-only, same as the rest of Settings', async ({ page }) => {
    expect((await page.request.get('/api/settings/builds')).status()).toBe(403);
    expect((await page.request.put('/api/settings/builds', { data: { cpus: 4, memoryMb: 8192, cacheCapGb: 50 } })).status()).toBe(403);
  });
});

test.describe('S15 System → build cache', () => {
  test.use({ storageState: storageStateFor('admin') });

  test('says "Not yet reported" before any agent has reported one', async ({ page }) => {
    await page.goto('/system');
    await h1(page, 'System');
    await expect(page.getByText('Build cache', { exact: true })).toBeVisible();
    await expect(page.getByText('Not yet reported')).toBeVisible();
  });

  test('shows the size, cap, last GC and applied limits after a real signed agent report — axe-clean in both themes, phone and desktop', async ({
    page,
  }) => {
    const key = makeKey();
    await withDb((db) => db.agent.update({ where: { id: fixture().agentId }, data: { publicKey: key.b64, fingerprint: key.fingerprint } }));

    const report = {
      agentVersion: '0.9.0',
      composeVersion: 'v5.2.1',
      engineApiVersion: '1.47',
      patExpiresAt: null,
      apps: [],
      buildCache: {
        bytes: 1_500_000_000,
        capBytes: 21_474_836_480,
        lastGcAt: '2026-09-27T03:00:00.000Z',
        limitsApplied: { cpus: 4, memoryMb: 8192 },
      },
    };
    const body = JSON.stringify(report);
    const reportRes = await page.request.post('/api/agent/report', {
      headers: signedHeaders(key, 'POST', '/api/agent/report', body),
      data: body,
    });
    expect(reportRes.ok(), await reportRes.text()).toBe(true);

    await page.goto('/system');
    await h1(page, 'System');
    await expect(page.getByText('1.50 GB')).toBeVisible();
    await expect(page.getByText('21.5 GB')).toBeVisible();
    await expect(page.getByText(/4 CPUs, 8192 MiB/)).toBeVisible();

    for (const theme of ['light', 'dark'] as const) {
      for (const phone of [false, true]) {
        await axeCleanAt(page, '/system', theme, phone);
      }
    }

    await restoreSeededAgentKey();
  });
});
