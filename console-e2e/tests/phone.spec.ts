import { expect, test, type Locator, type Page } from '@playwright/test';
import { settle } from '../harness/a11y.js';
import {
  DEPLOY_SHA,
  PHONE,
  TOUCH_TARGET_PX,
  appRow,
  clearGitHubSetting,
  dryRunStatus,
  expectPhoneFit,
  fakeDryRun,
  h1,
  json,
  needsYouRow,
  shortPrimaries,
  sidewaysScroll,
} from '../harness/console.js';
import { clearD3AuthSetting } from '../harness/d3auth.js';
import { withDb, type Db } from '../harness/db.js';
import { storageStateFor } from '../harness/env.js';
import { clearMailSetting } from '../harness/mail.js';
import { MINUTE, ago, enterAllClearWorld, fixture, reseedWorld, sha, type Fixture } from '../harness/seed.js';

/**
 * The phone pass (SHP-T-13.14), at 390 px on a touch screen:
 *
 * - SHP-REQ-172: no console screen scrolls sideways — the document is never wider than the viewport.
 * - SHP-REQ-166: every primary action is at least 44 px tall (@d3cloud/ui's coarse-pointer rule).
 * - SHP-REQ-173: every sheet opens from the bottom edge, its footer pinned while its body scrolls.
 *
 * The axe sweep (a11y.spec.ts) runs the first two on every screen state it opens; this file walks
 * each main screen on its own, so a failure names the screen, and proves the sheet's behaviour.
 */

test.use({ ...PHONE, storageState: storageStateFor('admin') });

const VIEWPORT = PHONE.viewport;

interface MainScreen {
  name: string;
  path: (fx: Fixture) => string;
  ready: (page: Page, fx: Fixture) => Promise<void>;
  /** Changes the seeded world first; the walk puts the baseline back after this screen. */
  world?: (db: Db) => Promise<void>;
}

/** Every main screen and section, with what shows it has loaded. */
const MAIN_SCREENS: MainScreen[] = [
  { name: 'Apps', path: () => '/', ready: (p, fx) => expect(appRow(p, fx.apps.history)).toBeVisible() },
  {
    name: 'Apps, all clear',
    path: () => '/',
    world: (db) => enterAllClearWorld(db),
    ready: async (p, fx) => {
      await expect(p.getByText(/^Nothing needs you\. \d+ up to date, \d+ ready\.$/)).toBeVisible();
      await expect(appRow(p, fx.apps.history)).toBeVisible();
    },
  },
  ...(['history', 'neverDeployed', 'drifted', 'frozen', 'approval', 'canary'] as const).map((which) => ({
    name: `App page, ${which}`,
    path: (fx: Fixture) => `/apps/${fx.apps[which]}`,
    ready: (p: Page, fx: Fixture) => h1(p, fx.apps[which]),
  })),
  { name: 'Commit page', path: (fx) => `/apps/${fx.apps.history}/commits/${sha(7)}`, ready: (p) => h1(p, 'Scanner ingest retries') },
  { name: 'Deploy page, soaking', path: (fx) => `/deploys/${fx.deploys.inProgress}`, ready: (p) => expect(p.getByRole('list', { name: 'Deploy steps' })).toBeVisible() },
  { name: 'Deploy page, rolled back', path: (fx) => `/deploys/${fx.deploys.rolledBack}`, ready: (p) => expect(p.getByRole('list', { name: 'Deploy steps' })).toBeVisible() },
  { name: 'Rollout', path: (fx) => `/rollouts/${fx.rollouts.stopped}`, ready: (p) => h1(p, 'Deploy all ready') },
  { name: 'Restore', path: (fx) => `/apps/${fx.apps.history}/restore`, ready: (p, fx) => h1(p, `Restore ${fx.apps.history}`) },
  { name: 'Activity', path: () => '/activity', ready: (p) => expect(p.locator('.shp-feed')).toBeVisible() },
  { name: 'Activity › schedules', path: () => '/activity?kind=schedule', ready: (p) => expect(p.getByRole('list', { name: 'Upcoming deploys' })).toBeVisible() },
  { name: 'Settings › Host', path: () => '/settings/host', ready: (p) => expect(p.getByRole('list', { name: 'Host health' })).toBeVisible() },
  { name: 'Settings › Claude & tokens', path: () => '/settings/tokens', ready: (p) => expect(p.getByRole('list', { name: 'API tokens' })).toBeVisible() },
  { name: 'Settings › People', path: () => '/settings/people', ready: (p) => expect(p.getByRole('heading', { name: 'Your account' })).toBeVisible() },
  {
    name: 'Settings › Integrations',
    path: () => '/settings/integrations',
    ready: (p) => expect(p.getByRole('button', { name: /^(Set up|Edit) alert email$/ })).toBeVisible(),
  },
  { name: 'Settings › Builds', path: () => '/settings/builds', ready: (p) => expect(p.getByRole('button', { name: 'Edit limits' })).toBeVisible() },
];

test('the phone this file emulates is 390 px wide with a coarse pointer', async ({ page }) => {
  await page.goto('/');
  await h1(page, 'Apps');
  const env = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    coarse: window.matchMedia('(pointer: coarse)').matches,
  }));
  // Without a coarse pointer the 44 px rule never applies, and the checks below would prove nothing.
  expect(env).toEqual({ width: VIEWPORT.width, coarse: true });
  // On a phone the tab bar is the navigation, with the three destinations (SHP-REQ-159).
  await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link')).toHaveText([/^Apps/, /^Activity/, /^Settings/]);
});

test('the phone checks bite: a page too wide, or a primary action too short, is caught', async ({ page }) => {
  await page.goto('/');
  await h1(page, 'Apps');
  await settle(page);
  expect(await sidewaysScroll(page)).toEqual({ overflow: 0, culprits: [] });
  expect(await shortPrimaries(page)).toEqual([]);
  await page.evaluate(() => {
    const wide = document.createElement('div');
    wide.className = 'console-e2e-too-wide';
    wide.style.width = '600px';
    wide.textContent = 'wider than a phone';
    const short = document.createElement('button');
    short.className = 'd3-btn d3-btn--primary console-e2e-too-short';
    short.style.cssText = 'min-height: 0; height: 30px';
    short.textContent = 'Too short';
    document.querySelector('main')?.append(wide, short);
  });
  const { overflow, culprits } = await sidewaysScroll(page);
  expect(overflow).toBeGreaterThan(0);
  expect(culprits.join('\n')).toContain('div.console-e2e-too-wide');
  expect(await shortPrimaries(page)).toEqual(['"Too short" is 30.0 px tall']);
});

test('SHP-REQ-172, SHP-REQ-166: every main screen at 390 px — nothing scrolls sideways, every primary action is 44 px tall', async ({
  page,
}) => {
  test.setTimeout(120_000);
  let primariesSeen = 0;
  for (const screen of MAIN_SCREENS) {
    const world = screen.world;
    if (world !== undefined) await withDb((db) => world(db));
    try {
      const fx = fixture();
      await page.goto(screen.path(fx));
      await screen.ready(page, fx);
      await settle(page);
      await expectPhoneFit(page, screen.name);
      primariesSeen += await page.locator('.d3-btn--primary:visible').count();
    } finally {
      if (world !== undefined) await withDb((db) => reseedWorld(db));
    }
  }
  // The check measured something: Apps alone offers a deploy and an approval.
  expect(primariesSeen).toBeGreaterThan(3);
});

test('SHP-REQ-172: the app page’s tabs and a long feed stay inside 390 px', async ({ page }) => {
  const fx = fixture();
  await page.goto(`/apps/${fx.apps.history}`);
  await h1(page, fx.apps.history);
  for (const tab of ['Deploys', 'Backups', 'Config']) {
    await page.getByRole('tab', { name: tab }).click();
    await expect(page.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
    await settle(page);
    await expectPhoneFit(page, `App page › ${tab}`);
  }
  // The manifest is the widest thing on it: opened, it wraps or scrolls in its own box.
  await page.getByText('Show the manifest').click();
  await expect(page.getByRole('textbox', { name: 'Manifest' })).toBeVisible();
  await expectPhoneFit(page, 'App page › Config, manifest open');
});

// ── SHP-REQ-173: sheets ──────────────────────────────────────────────────────

/** Where a sheet sits and how its parts behave, measured in the page. */
async function sheetGeometry(sheet: Locator) {
  return sheet.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const body = el.querySelector('.d3-modal__body');
    const footer = el.querySelector('.d3-modal__footer');
    const bodyStyle = body === null ? null : getComputedStyle(body);
    return {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      width: rect.width,
      viewportHeight: window.innerHeight,
      viewportWidth: document.documentElement.clientWidth,
      sheetScrolls: el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY !== 'hidden',
      bodyOverflowY: bodyStyle?.overflowY ?? null,
      bodyScrollable: body === null ? 0 : body.scrollHeight - body.clientHeight,
      footer:
        footer === null
          ? null
          : { top: footer.getBoundingClientRect().top, bottom: footer.getBoundingClientRect().bottom, height: footer.getBoundingClientRect().height },
    };
  });
}

/**
 * A sheet at 390 px: full width, on the bottom edge, its body the part that scrolls, and a footer —
 * holding the sheet's action — on screen (SHP-REQ-173).
 */
async function expectBottomSheet(sheet: Locator, name: string): Promise<void> {
  await expect(sheet).toBeVisible();
  await settle(sheet.page());
  const g = await sheetGeometry(sheet);
  expect(Math.abs(g.bottom - g.viewportHeight), `${name}: the sheet's bottom edge is the screen's`).toBeLessThanOrEqual(1);
  expect(g.left, `${name}: starts at the left edge`).toBe(0);
  expect(g.width, `${name}: spans the screen`).toBe(g.viewportWidth);
  expect(g.top, `${name}: leaves the top of the page in view`).toBeGreaterThan(0);
  expect(g.sheetScrolls, `${name}: the sheet itself never scrolls; its body does`).toBe(false);
  expect(g.bodyOverflowY, `${name}: the body is the part that scrolls`).toMatch(/^(auto|scroll)$/);
  expect(g.footer, `${name}: has a footer`).not.toBeNull();
  expect(g.footer?.height ?? 0, `${name}: has a footer`).toBeGreaterThan(0);
  expect(g.footer?.bottom ?? Infinity, `${name}: the footer is on screen`).toBeLessThanOrEqual(g.viewportHeight);
  await expect(sheet.locator('.d3-modal__footer').getByRole('button').last(), `${name}: its action is in the footer`).toBeInViewport();
}

/**
 * The body of a sheet taller than the room it has: scrolled to its end, the sheet does not move and
 * its footer stays exactly where it was, on screen (SHP-REQ-173).
 */
async function expectPinnedWhileScrolling(sheet: Locator, name: string): Promise<void> {
  const before = await sheetGeometry(sheet);
  expect(before.bodyScrollable, `${name}: the body is taller than the sheet, so it scrolls`).toBeGreaterThan(0);
  const body = sheet.locator('.d3-modal__body');
  await body.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  const after = await sheetGeometry(sheet);
  expect(after.bottom, `${name}: the sheet did not move`).toBe(before.bottom);
  expect(after.top, `${name}: the sheet did not move`).toBe(before.top);
  expect(after.footer, `${name}: the footer did not move`).toEqual(before.footer);
  expect(after.footer?.bottom ?? Infinity).toBeLessThanOrEqual(after.viewportHeight);
}

test('SHP-REQ-173: the deploy sheet opens from the bottom edge, its footer pinned while its body scrolls', async ({ page }) => {
  const fx = fixture();
  const target = sha(7);
  // A long deploy: fourteen commits and every check, more than a phone's height, so the body must scroll.
  const commits = Array.from({ length: 14 }, (_, i) => ({
    sha: i === 13 ? target : sha(800 + i),
    message: `BND-T-99.${String(i + 1)}: a change long enough to wrap onto a second line on a phone screen`,
    ci: 'success',
    taskIds: [`BND-T-99.${String(i + 1)}`],
  }));
  await page.route(
    (url) => url.pathname === `/api/apps/${fx.apps.history}/commits` && url.searchParams.has('to'),
    (route) => json(route, 200, { live: sha(4), commits, newestGreen: target, source: 'github' }),
  );
  const gates = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10'].map((gate) => ({ gate, pass: true, reason: 'ok' }));
  await fakeDryRun(page, dryRunStatus(fx.apps.history, target, { gates }));

  await page.goto('/');
  await appRow(page, fx.apps.history).getByRole('button', { name: DEPLOY_SHA }).click();
  const sheet = page.getByRole('dialog', { name: `Deploy ${fx.apps.history} ${target.slice(0, 7)}` });
  await expect(sheet.getByRole('heading', { name: 'Checks' })).toBeVisible();
  const confirm = sheet.getByRole('button', { name: `Deploy ${target.slice(0, 7)}` });
  await expect(confirm).toBeEnabled();

  await expectBottomSheet(sheet, 'Deploy sheet');
  // Scroll the body to its end: the sheet does not move, the footer stays where it was, on screen.
  await expectPinnedWhileScrolling(sheet, 'Deploy sheet');
  await expect(sheet.getByText('What happens')).toBeInViewport();
  await expect(confirm).toBeInViewport();
  // The primary in the pinned footer is a touch target too.
  expect(await shortPrimaries(page)).toEqual([]);
  expect((await confirm.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(TOUCH_TARGET_PX);
});

test('SHP-REQ-173: a form sheet keeps its action pinned too — Freeze on a short phone screen', async ({ page }) => {
  // A phone in landscape-ish height: the freeze form is taller than the room the sheet has.
  await page.setViewportSize({ width: VIEWPORT.width, height: 420 });
  const fx = fixture();
  await page.goto(`/apps/${fx.apps.history}`);
  await h1(page, fx.apps.history);
  await settle(page);
  await page.getByRole('button', { name: 'Freeze', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: `Freeze ${fx.apps.history}` });
  await expectBottomSheet(sheet, 'Freeze sheet');
  await expectPinnedWhileScrolling(sheet, 'Freeze sheet');
  // The action stays reachable: type a reason at the end of the form, and Freeze is enabled on screen.
  await sheet.getByRole('textbox', { name: 'Reason' }).fill('console-e2e: checking the footer stays put');
  const action = sheet.locator('.d3-modal__footer').getByRole('button', { name: `Freeze ${fx.apps.history}` });
  await expect(action).toBeEnabled();
  await expect(action).toBeInViewport();
});

/** A running build to cancel, made for the sheets below and removed after them. */
let runningBuild = '';

/** Opens a card on Settings › Integrations in place. */
async function openCard(p: Page, button: RegExp, form: string): Promise<void> {
  await p.getByRole('button', { name: button }).click();
  await expect(p.getByRole('form', { name: form })).toBeVisible();
}

test.describe('every other sheet on a phone', () => {
  test.beforeAll(async () => {
    const fx = fixture();
    runningBuild = await withDb(async (db) => {
      const app = await db.app.findUniqueOrThrow({ where: { name: fx.apps.history }, select: { id: true } });
      const startedAt = ago(5 * MINUTE);
      const build = await db.build.create({
        data: {
          appId: app.id,
          sha: sha(7),
          state: 'running',
          trigger: 'webhook',
          requesterLabel: 'push to main',
          dispatchedAt: startedAt,
          startedAt,
          createdAt: startedAt,
        },
        select: { id: true },
      });
      await db.buildStageRun.create({ data: { buildId: build.id, stage: 'fetch', state: 'running', startedAt } });
      return build.id;
    });
  });

  test.afterAll(async () => {
    // Nothing below confirms anything, but a sheet's form can be half-filled, and three of them
    // store a setting to reach their confirm: start the next file clean.
    await withDb(async (db) => {
      await db.buildStageRun.deleteMany({ where: { buildId: runningBuild } });
      await db.build.deleteMany({ where: { id: runningBuild } });
      await reseedWorld(db);
    });
    await clearD3AuthSetting();
    await clearMailSetting();
    await clearGitHubSetting();
  });

  const SHEETS: { name: string; path: (fx: Fixture) => string; open: (page: Page, fx: Fixture) => Promise<Locator> }[] = [
    {
      name: 'Approval review',
      path: () => '/',
      open: async (p, fx) => {
        await fakeDryRun(p, dryRunStatus(fx.apps.approval, sha(42), {}));
        await needsYouRow(p, fx.apps.approval).getByRole('button', { name: /^Approve and deploy/ }).click();
        return p.getByRole('dialog', { name: /^Approve deploy of/ });
      },
    },
    {
      name: 'Deny confirm',
      path: () => '/',
      open: async (p, fx) => {
        await needsYouRow(p, fx.apps.approval).getByRole('button', { name: 'Deny' }).click();
        return p.getByRole('dialog', { name: /^Deny / });
      },
    },
    {
      name: 'Group deploy',
      path: () => '/',
      open: async (p, fx) => {
        await p.getByRole('button', { name: `Deploy group ${fx.group}` }).click();
        return p.getByRole('dialog', { name: `Deploy group ${fx.group}` });
      },
    },
    {
      name: 'Roll back',
      path: (fx) => `/apps/${fx.apps.history}`,
      open: async (p, fx) => {
        await fakeDryRun(p, dryRunStatus(fx.apps.history, sha(2), { kind: 'rollback' }));
        await p.getByRole('button', { name: /^Roll back to / }).first().click();
        return p.getByRole('dialog', { name: /^Roll back / });
      },
    },
    {
      name: 'Freeze',
      path: (fx) => `/apps/${fx.apps.history}`,
      open: async (p, fx) => {
        await p.getByRole('button', { name: 'Freeze', exact: true }).click();
        return p.getByRole('dialog', { name: `Freeze ${fx.apps.history}` });
      },
    },
    {
      name: 'Unfreeze',
      path: (fx) => `/apps/${fx.apps.frozen}`,
      open: async (p, fx) => {
        await p.getByRole('button', { name: 'Unfreeze', exact: true }).click();
        return p.getByRole('dialog', { name: `Unfreeze ${fx.apps.frozen}` });
      },
    },
    {
      name: 'Adopt what’s running',
      path: (fx) => `/apps/${fx.apps.drifted}`,
      open: async (p) => {
        await p.getByRole('button', { name: "Adopt what's running" }).click();
        return p.getByRole('dialog', { name: /^Adopt what's running on / });
      },
    },
    {
      name: 'Redeploy over drift',
      path: (fx) => `/apps/${fx.apps.drifted}`,
      open: async (p) => {
        await p.getByRole('button', { name: 'Redeploy recorded release' }).click();
        return p.getByRole('dialog', { name: /recorded release$/ });
      },
    },
    {
      name: 'Schedule a deploy',
      path: () => '/activity',
      open: async (p) => {
        await p.getByRole('button', { name: 'Schedule a deploy' }).click();
        return p.getByRole('dialog', { name: 'Schedule a deploy' });
      },
    },
    {
      name: 'Restore confirm',
      path: (fx) => `/apps/${fx.apps.history}/restore`,
      open: async (p, fx) => {
        await p.getByRole('button', { name: /^Restore the backup taken/ }).first().click();
        return p.getByRole('dialog', { name: `Restore ${fx.apps.history}` });
      },
    },
    {
      name: 'Revoke a token',
      path: () => '/settings/tokens',
      open: async (p) => {
        await p.getByRole('button', { name: /^Revoke / }).first().click();
        return p.getByRole('dialog', { name: 'Revoke this token?' });
      },
    },
    {
      name: 'Deploy all ready',
      path: () => '/',
      open: async (p, fx) => {
        // Show the frozen app as unfrozen so two are ready, and answer the plan with a canned order.
        await p.route(
          (url) => url.pathname === '/api/apps',
          async (route) => {
            const res = await route.fetch();
            const body = (await res.json()) as { apps: { name: string; frozen?: boolean }[] };
            await route.fulfill({ response: res, json: { ...body, apps: body.apps.map((a) => (a.name === fx.apps.frozen ? { ...a, frozen: false } : a)) } });
          },
        );
        await p.route(
          (url) => url.pathname === '/api/rollouts/plan',
          (route) =>
            json(route, 200, {
              members: [
                { app: fx.apps.history, sha: '2'.repeat(40), liveSha: 'f'.repeat(40), self: false },
                { app: 'shipyard', sha: '3'.repeat(40), liveSha: 'e'.repeat(40), self: true },
              ],
            }),
        );
        await p.reload();
        await p.getByRole('button', { name: /^Deploy all ready \(\d+\)$/ }).click();
        return p.getByRole('dialog', { name: /^Deploy all ready/ });
      },
    },
    {
      name: 'Cancel a schedule',
      path: () => '/activity?kind=schedule',
      open: async (p) => {
        await p.getByRole('button', { name: /^Cancel / }).first().click();
        return p.getByRole('dialog', { name: /^Cancel the deploy of/ });
      },
    },
    {
      name: 'Revoke agent',
      path: () => '/settings/host',
      open: async (p) => {
        await p.getByRole('button', { name: 'Revoke agent' }).click();
        return p.getByRole('dialog', { name: 'Revoke this agent?' });
      },
    },
    {
      name: 'Renew the agent’s token',
      path: () => '/settings/host',
      open: async (p) => {
        await p.getByRole('button', { name: 'Renew…' }).click();
        return p.getByRole('dialog', { name: "Renew the agent's GitHub token" });
      },
    },
    {
      name: 'Turn off Sign in with D3 Auth',
      path: () => '/settings/integrations',
      open: async (p) => {
        // An issuer nothing answers is saved, which is what offers Turn off.
        await openCard(p, /^(Set up|Edit) Sign in with D3 Auth$/, 'Sign in with D3 Auth');
        await p.getByRole('textbox', { name: 'Issuer' }).fill('http://127.0.0.1:9');
        await p.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(p.getByText('Configured, but the D3 Auth button is off')).toBeVisible();
        await p.getByRole('button', { name: 'Turn off', exact: true }).click();
        return p.getByRole('dialog', { name: 'Turn off Sign in with D3 Auth?' });
      },
    },
    {
      name: 'Turn off alert email',
      path: () => '/settings/integrations',
      open: async (p) => {
        await openCard(p, /^(Set up|Edit) alert email$/, 'Alert email');
        const form = p.getByRole('form', { name: 'Alert email' });
        await form.getByRole('textbox', { name: /^Relay URL/ }).fill('http://127.0.0.1:9/send');
        await form.getByLabel(/^Relay token/).fill('console-e2e-phone-relay-token');
        await form.getByRole('textbox', { name: /^Recipient/ }).fill('ops@shipyard.test');
        await p.getByRole('button', { name: 'Save alert email', exact: true }).click();
        await expect(p.getByText('Alerts on', { exact: true })).toBeVisible();
        await p.getByRole('button', { name: 'Turn off alert email', exact: true }).click();
        return p.getByRole('dialog', { name: 'Turn off alert email?' });
      },
    },
    {
      name: 'Remove the GitHub token',
      path: () => '/settings/integrations',
      open: async (p) => {
        await openCard(p, /^(Add a|Edit) GitHub token$/, 'GitHub access');
        await p.getByLabel('GitHub token', { exact: true }).fill('github_pat_console_e2e_phone_sheet');
        await p.getByRole('button', { name: 'Save GitHub token', exact: true }).click();
        await expect(p.getByText('GitHub token saved', { exact: true })).toBeVisible();
        await p.getByRole('button', { name: 'Remove the GitHub token', exact: true }).click();
        return p.getByRole('dialog', { name: 'Remove the GitHub token?' });
      },
    },
    {
      name: 'Cancel build',
      path: () => `/builds/${runningBuild}`,
      open: async (p) => {
        await p.getByRole('button', { name: 'Cancel build' }).click();
        return p.getByRole('dialog', { name: 'Cancel this build?' });
      },
    },
    {
      name: 'Deny on the deploy page',
      path: (fx) => `/deploys/${fx.deploys.awaitingApproval}`,
      open: async (p, fx) => {
        await p.getByRole('button', { name: 'Deny', exact: true }).click();
        return p.getByRole('dialog', { name: new RegExp(`^Deny ${fx.apps.approval} at [0-9a-f]{7}$`) });
      },
    },
  ];

  for (const s of SHEETS) {
    test(`SHP-REQ-173: ${s.name} opens from the bottom edge with its footer on screen`, async ({ page }) => {
      const fx = fixture();
      await page.goto(s.path(fx));
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await settle(page);
      const sheet = await s.open(page, fx);
      await expectBottomSheet(sheet, s.name);
      await expectPhoneFit(page, `${s.name} sheet`);
    });
  }
});
