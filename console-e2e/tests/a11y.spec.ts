import { expect, test, type Page } from '@playwright/test';
import { axeViolations, expectTheme, forceTheme, settle, type Theme } from '../harness/a11y.js';
import { enterZeroUserWorld, restoreAccounts } from '../harness/accounts.js';
import { DEPLOY_SHA, appRow, dialog, expectPhoneFit, h1, needsYou, needsYouRow, useWidth, type Width } from '../harness/console.js';
import { clearD3AuthSetting } from '../harness/d3auth.js';
import { clearMailSetting } from '../harness/mail.js';
import { withDb, type Db } from '../harness/db.js';
import { USERS, storageStateFor, type RoleName } from '../harness/env.js';
import { enterAllClearWorld, fixture, reseedWorld, sha, type Fixture } from '../harness/seed.js';

/**
 * SHP-T-6.2 and SHP-T-13.14, SHP-REQ-090: every screen of the redesigned console, in both themes and
 * at both widths — 1440 px and a 390 px touch phone — has no serious or critical axe violation.
 *
 * "Every screen" is every route in apps/web/src/routes.tsx, plus the states of a screen that put
 * different things in front of a person: each sheet, modal, menu and confirm any screen can open
 * (the deploy sheet as a deploy, an approval, a group and every ready app; deny, adopt, redeploy,
 * freeze and unfreeze; a schedule's cancel; an agent's revoke; a token's and an invite's "shown
 * once"), an app never deployed, drifted, frozen, held for approval and mid-deploy, each app tab, a
 * deploy succeeded, rolled back and refused, the viewer's refusals. A contrast failure only exists in
 * one theme, and a phone layout is a different page, so each is checked four times.
 *
 * At 390 px the same pass also proves the phone rules on every one of those screens: the document
 * never scrolls sideways (SHP-REQ-172) and every visible primary action is at least 44 px tall
 * (SHP-REQ-166).
 */

interface Ctx {
  fx: Fixture;
  phone: boolean;
}

interface Screen {
  name: string;
  /** Who is signed in; null for the signed-out screens. */
  as: RoleName | null;
  path: (fx: Fixture) => string;
  /** Resolves once the screen shows its data (not its skeleton). */
  ready: (page: Page, ctx: Ctx) => Promise<void>;
  /** After ready: open the sheet or menu this scenario is about. */
  act?: (page: Page, ctx: Ctx) => Promise<void>;
  /** A screen that exists at one width only (the phone's navigation drawer). */
  only?: Width;
  /** Runs in a server with no account at all (first-run setup), then puts the accounts back. */
  zeroUsers?: boolean;
  /** Changes the seeded world first; the baseline is put back after the test. */
  world?: (db: Db) => Promise<void>;
}

/** The held d3auth deploy's SHA (seed.ts: the approval app's second commit). */
const HELD_SHA7 = sha(42).slice(0, 7);

/** Settings › Integrations › Alert email: saves a relay nothing listens on (the setting is cleared after the sweep). */
const saveDeadRelay = async (page: Page) => {
  await page.getByRole('button', { name: /^(Set up|Edit) alert email$/ }).click();
  const form = page.getByRole('form', { name: 'Alert email' });
  await form.getByRole('textbox', { name: /^Relay URL/ }).fill('http://127.0.0.1:9/send');
  await form.getByLabel(/^Relay token/).fill('console-e2e-a11y-relay-token');
  await form.getByRole('textbox', { name: /^Recipient/ }).fill('ops@shipyard.test');
  await page.getByRole('button', { name: 'Save alert email', exact: true }).click();
  await expect(page.getByText('Alerts on', { exact: true })).toBeVisible();
};

/** Settings › Integrations › Sign in with D3 Auth, opened in place. */
const openD3Auth = async (page: Page) => {
  await page.getByRole('button', { name: /^(Set up|Edit) Sign in with D3 Auth$/ }).click();
  await expect(page.getByRole('form', { name: 'Sign in with D3 Auth' })).toBeVisible();
};

/** The app page, by the parts every variant has: its name, the Next up card and the record tabs. */
const appPage = async (page: Page, app: string) => {
  await h1(page, app);
  await expect(page.getByRole('heading', { name: /^Next up/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Deploys' })).toBeVisible();
};

const SCREENS: Screen[] = [
  // S1 Sign in — both steps.
  { name: 'S1 sign in', as: null, path: () => '/signin', ready: (p) => h1(p, 'Sign in') },
  {
    name: 'S1 sign in, authenticator step',
    as: null,
    path: () => '/signin',
    ready: (p) => h1(p, 'Sign in'),
    act: async (p) => {
      await p.getByRole('textbox', { name: 'Email' }).fill(USERS.viewer.email);
      await p.getByLabel('Password', { exact: true }).fill(USERS.viewer.password);
      await p.getByRole('button', { name: 'Continue' }).click();
      await expect(p.getByText('Authenticator code')).toBeVisible();
    },
  },
  // S2 Apps (SHP-T-13.8): Needs you, then every app as one row.
  {
    name: 'S2 apps',
    as: 'admin',
    path: () => '/',
    ready: async (p, { fx }) => {
      await h1(p, 'Apps');
      await expect(needsYou(p)).toBeVisible();
      await expect(appRow(p, fx.apps.history).getByRole('button', { name: DEPLOY_SHA })).toBeVisible();
    },
  },
  {
    name: 'S2 apps — all clear',
    as: 'admin',
    world: (db) => enterAllClearWorld(db),
    path: () => '/',
    ready: async (p, { fx }) => {
      await h1(p, 'Apps');
      // Nothing waits on a person: one calm line instead of the Needs you list (SHP-D-089).
      await expect(p.getByText(/^Nothing needs you\. \d+ up to date, \d+ ready\.$/)).toBeVisible();
      await expect(needsYou(p)).toHaveCount(0);
      await expect(appRow(p, fx.apps.history)).toBeVisible();
    },
  },
  {
    name: 'S2 apps as a viewer',
    as: 'viewer',
    path: () => '/',
    ready: async (p, { fx }) => {
      await h1(p, 'Apps');
      await expect(appRow(p, fx.apps.history)).toBeVisible();
    },
  },
  {
    name: 'S2 apps, account menu open',
    as: 'admin',
    path: () => '/',
    ready: (p) => h1(p, 'Apps'),
    act: async (p, { phone }) => {
      // On a phone the account menu lives in the navigation drawer; the tab bar is the navigation.
      if (phone) await p.getByRole('button', { name: 'Open navigation' }).click();
      await p.getByRole('button', { name: new RegExp(USERS.admin.displayName) }).click();
      await expect(p.getByRole('menuitem', { name: 'Account' })).toBeVisible();
    },
  },
  {
    name: 'S2 apps, navigation drawer',
    as: 'admin',
    only: 'phone',
    path: () => '/',
    ready: async (p) => {
      await h1(p, 'Apps');
      await expect(p.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: /^Settings/ })).toBeVisible();
    },
    act: async (p) => {
      await p.getByRole('button', { name: 'Open navigation' }).click();
      await expect(p.getByRole('button', { name: 'Close navigation' })).toBeVisible();
    },
  },
  {
    name: 'S2 apps, an app row’s menu',
    as: 'admin',
    path: () => '/',
    ready: (p) => h1(p, 'Apps'),
    act: async (p, { fx }) => {
      await p.getByRole('button', { name: `More for ${fx.apps.history}` }).click();
      await expect(p.getByRole('menuitem', { name: `Open ${fx.apps.history}` })).toBeVisible();
    },
  },
  {
    name: 'S2 apps, deny confirm',
    as: 'admin',
    path: () => '/',
    ready: (p) => h1(p, 'Apps'),
    act: async (p, { fx }) => {
      await needsYouRow(p, fx.apps.approval).getByRole('button', { name: 'Deny' }).click();
      await dialog(p, new RegExp(`^Deny ${fx.apps.approval}`));
    },
  },
  {
    name: 'S2 apps, adopt what’s running from Needs you',
    as: 'admin',
    path: () => '/',
    ready: (p) => h1(p, 'Apps'),
    act: async (p, { fx }) => {
      await needsYouRow(p, fx.apps.drifted).getByRole('button', { name: "Adopt what's running" }).click();
      await dialog(p, `Adopt what's running on ${fx.apps.drifted}`);
    },
  },
  // S3 The deploy sheet — a deploy, an approval, a group, and every ready app.
  {
    name: 'S3 deploy sheet, deploy',
    as: 'admin',
    path: () => '/',
    ready: (p) => h1(p, 'Apps'),
    act: async (p, { fx }) => {
      await appRow(p, fx.apps.history).getByRole('button', { name: DEPLOY_SHA }).click();
      await dialog(p, new RegExp(`^Deploy ${fx.apps.history} [0-9a-f]{7}$`));
    },
  },
  {
    name: 'S3 deploy sheet, approval review',
    as: 'admin',
    path: () => '/',
    ready: (p) => h1(p, 'Apps'),
    act: async (p, { fx }) => {
      await needsYouRow(p, fx.apps.approval).getByRole('button', { name: `Approve and deploy ${HELD_SHA7}` }).click();
      await dialog(p, `Approve deploy of ${fx.apps.approval} ${HELD_SHA7}`);
    },
  },
  {
    name: 'S3 group deploy sheet',
    as: 'admin',
    path: () => '/',
    ready: (p) => h1(p, 'Apps'),
    act: async (p, { fx }) => {
      await p.getByRole('button', { name: `Deploy group ${fx.group}` }).click();
      await dialog(p, `Deploy group ${fx.group}`);
    },
  },
  {
    name: 'S3 deploy all ready sheet',
    as: 'admin',
    path: () => '/',
    ready: (p) => h1(p, 'Apps'),
    act: async (p, { fx }) => {
      // Show the frozen app as unfrozen so at least two are ready, and answer the plan with a canned
      // order, Shipyard last.
      await p.route(
        (url) => url.pathname === '/api/apps',
        async (route) => {
          const res = await route.fetch();
          const body = (await res.json()) as { apps: { name: string; frozen?: boolean }[] };
          const apps = body.apps.map((a) => (a.name === fx.apps.frozen ? { ...a, frozen: false } : a));
          await route.fulfill({ response: res, json: { ...body, apps } });
        },
      );
      await p.route(
        (url) => url.pathname === '/api/rollouts/plan',
        (route) =>
          route.fulfill({
            status: 200,
            json: {
              members: [
                { app: fx.apps.history, sha: '2'.repeat(40), liveSha: 'f'.repeat(40), self: false },
                { app: 'shipyard', sha: '3'.repeat(40), liveSha: 'e'.repeat(40), self: true },
              ],
            },
          }),
      );
      await p.reload();
      await h1(p, 'Apps');
      await p.getByRole('button', { name: /^Deploy all ready \(\d+\)$/ }).click();
      await dialog(p, /^Deploy all ready/);
      await expect(p.getByRole('list', { name: 'Apps to deploy, in order' })).toBeVisible();
    },
  },
  // S4 Deploy — the one page (SHP-T-13.11), reached through the old live address, which redirects.
  {
    name: 'S4 deploy page, soaking',
    as: 'admin',
    path: (fx) => `/deploys/${fx.deploys.inProgress}/live`,
    ready: async (p, { phone }) => {
      await expect(p.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(p.getByText('Requested by', { exact: true })).toBeVisible();
      await expect(p.getByRole('region', { name: /^Soaking/ })).toBeVisible();
      // On a phone the step that is running is on screen without scrolling.
      if (phone) await expect(p.getByRole('list', { name: 'Deploy steps' }).locator('[aria-current="step"]')).toBeInViewport();
    },
  },
  {
    name: 'S4 deploy page, rolled back',
    as: 'admin',
    path: (fx) => `/deploys/${fx.deploys.rolledBack}/live`,
    ready: async (p) => {
      await expect(p.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(p.getByText('Requested by', { exact: true })).toBeVisible();
      await expect(p.getByRole('region', { name: /^Rolled back/ })).toBeVisible();
    },
  },
  {
    name: 'Rollout, stopped at a rolled-back app',
    as: 'admin',
    path: (fx) => `/rollouts/${fx.rollouts.stopped}`,
    ready: async (p) => {
      await h1(p, 'Deploy all ready');
      await expect(p.getByText(/^The rollout stopped at/)).toBeVisible();
    },
  },
  {
    name: 'Rollout as a viewer',
    as: 'viewer',
    path: (fx) => `/rollouts/${fx.rollouts.stopped}`,
    ready: async (p) => {
      await h1(p, 'Deploy all ready');
      await expect(p.getByRole('list', { name: 'Apps in this rollout, in order' })).toBeVisible();
    },
  },
  // S5 The app page (SHP-T-13.12) — every variant.
  ...(
    [
      ['with history', (fx: Fixture) => fx.apps.history],
      ['never deployed', (fx: Fixture) => fx.apps.neverDeployed],
      ['drifted', (fx: Fixture) => fx.apps.drifted],
      ['frozen', (fx: Fixture) => fx.apps.frozen],
      ['awaiting approval', (fx: Fixture) => fx.apps.approval],
      ['deploy in progress', (fx: Fixture) => fx.apps.canary],
    ] as const
  ).map(
    ([variant, app]): Screen => ({
      name: `S5 app page — ${variant}`,
      as: 'admin',
      path: (fx) => `/apps/${app(fx)}`,
      ready: (p, { fx }) => appPage(p, app(fx)),
    }),
  ),
  {
    name: 'S5 app page — as a viewer',
    as: 'viewer',
    path: (fx) => `/apps/${fx.apps.history}`,
    ready: (p, { fx }) => appPage(p, fx.apps.history),
  },
  {
    name: 'S5 app page — no such app',
    as: 'admin',
    path: () => '/apps/no-such-app',
    ready: (p) => expect(p.getByText('No app named no-such-app.')).toBeVisible(),
  },
  {
    name: 'S5 app page — Backups tab',
    as: 'admin',
    path: (fx) => `/apps/${fx.apps.history}`,
    ready: (p, { fx }) => appPage(p, fx.apps.history),
    act: async (p) => {
      await p.getByRole('tab', { name: 'Backups' }).click();
      await expect(p.getByRole('list', { name: 'Recent backups' })).toBeVisible();
    },
  },
  {
    name: 'S5 app page — Config tab',
    as: 'admin',
    path: (fx) => `/apps/${fx.apps.history}`,
    ready: (p, { fx }) => appPage(p, fx.apps.history),
    act: async (p) => {
      await p.getByRole('tab', { name: 'Config' }).click();
      await expect(p.getByRole('heading', { name: 'How it deploys' })).toBeVisible();
    },
  },
  {
    name: 'S5 app page — more menu',
    as: 'admin',
    path: (fx) => `/apps/${fx.apps.history}`,
    ready: (p, { fx }) => appPage(p, fx.apps.history),
    act: async (p, { fx }) => {
      await p.getByRole('group', { name: `Actions for ${fx.apps.history}` }).getByRole('button', { name: `More for ${fx.apps.history}` }).click();
      await expect(p.getByRole('menuitem', { name: `All activity for ${fx.apps.history}` })).toBeVisible();
    },
  },
  {
    name: 'S5 app page — roll back sheet',
    as: 'admin',
    path: (fx) => `/apps/${fx.apps.history}`,
    ready: (p, { fx }) => appPage(p, fx.apps.history),
    act: async (p, { fx }) => {
      await p.getByRole('button', { name: /^Roll back to [0-9a-f]{7}$/ }).first().click();
      await dialog(p, new RegExp(`^Roll back ${fx.apps.history} to [0-9a-f]{7}$`));
    },
  },
  {
    name: 'S5 app page — drifted, adopt what’s running',
    as: 'admin',
    path: (fx) => `/apps/${fx.apps.drifted}`,
    ready: (p, { fx }) => appPage(p, fx.apps.drifted),
    act: async (p, { fx }) => {
      await p.getByRole('button', { name: "Adopt what's running" }).click();
      await dialog(p, `Adopt what's running on ${fx.apps.drifted}`);
    },
  },
  {
    name: 'S5 app page — drifted, redeploy recorded release',
    as: 'admin',
    path: (fx) => `/apps/${fx.apps.drifted}`,
    ready: (p, { fx }) => appPage(p, fx.apps.drifted),
    act: async (p, { fx }) => {
      await p.getByRole('button', { name: 'Redeploy recorded release' }).click();
      await dialog(p, `Redeploy ${fx.apps.drifted}'s recorded release`);
    },
  },
  // S10 Freeze, from the app page's header.
  {
    name: 'S10 freeze sheet',
    as: 'admin',
    path: (fx) => `/apps/${fx.apps.history}`,
    ready: (p, { fx }) => appPage(p, fx.apps.history),
    act: async (p, { fx }) => {
      await p.getByRole('button', { name: 'Freeze', exact: true }).click();
      await dialog(p, `Freeze ${fx.apps.history}`);
    },
  },
  {
    name: 'S10 unfreeze confirm, already frozen',
    as: 'admin',
    path: (fx) => `/apps/${fx.apps.frozen}`,
    ready: (p, { fx }) => appPage(p, fx.apps.frozen),
    act: async (p, { fx }) => {
      await p.getByRole('button', { name: 'Unfreeze', exact: true }).click();
      await dialog(p, `Unfreeze ${fx.apps.frozen}`);
    },
  },
  // The commit page (SHP-T-13.4): a commit ready to deploy, and one whose CI failed.
  {
    name: 'Commit page — ready',
    as: 'admin',
    path: (fx) => `/apps/${fx.apps.history}/commits/${sha(7)}`,
    ready: async (p) => {
      await h1(p, 'Scanner ingest retries');
      await expect(p.getByRole('button', { name: `Deploy ${sha(7).slice(0, 7)}` })).toBeVisible();
    },
  },
  {
    name: 'Commit page — CI failed',
    as: 'admin',
    path: (fx) => `/apps/${fx.apps.history}/commits/${sha(5)}`,
    ready: (p) => h1(p, 'Fix search ranking'),
  },
  // S6 Deploy record — the same one page once a deploy has ended (SHP-T-13.11).
  ...(['succeeded', 'rolledBack', 'refused', 'awaitingApproval'] as const).map(
    (which): Screen => ({
      name: `S6 deploy record, ${which}`,
      as: 'admin',
      path: (fx) => `/deploys/${fx.deploys[which]}`,
      ready: async (p) => {
        await expect(p.getByRole('heading', { level: 1 })).toHaveText(/^(Deploy|Roll back|Restore) /);
        await expect(p.getByRole('group', { name: 'Next actions' })).toBeVisible();
      },
    }),
  ),
  // S7 Restore, and its typed confirmation.
  {
    name: 'S7 restore',
    as: 'admin',
    path: (fx) => `/apps/${fx.apps.history}/restore`,
    ready: async (p, { fx }) => {
      await h1(p, `Restore ${fx.apps.history}`);
      await expect(p.getByRole('button', { name: /^Restore the backup taken/ }).first()).toBeVisible();
    },
  },
  {
    name: 'S7 restore, confirm sheet',
    as: 'admin',
    path: (fx) => `/apps/${fx.apps.history}/restore`,
    ready: (p, { fx }) => h1(p, `Restore ${fx.apps.history}`),
    act: async (p, { fx }) => {
      await p.getByRole('button', { name: /^Restore the backup taken/ }).first().click();
      await dialog(p, `Restore ${fx.apps.history}`);
    },
  },
  {
    name: 'S7 restore, never deployed',
    as: 'admin',
    path: (fx) => `/apps/${fx.apps.neverDeployed}/restore`,
    ready: (p, { fx }) => h1(p, `Restore ${fx.apps.neverDeployed}`),
  },
  // S8 Activity (SHP-T-13.13): the feed, a filter that matches nothing, schedules and a rollout row.
  {
    name: 'S8 activity',
    as: 'admin',
    path: () => '/activity',
    ready: async (p, { fx }) => {
      await h1(p, 'Activity');
      await expect(p.getByRole('list', { name: 'Upcoming deploys' })).toBeVisible();
      await expect(p.locator('.shp-feed').getByText(fx.apps.history).first()).toBeVisible();
    },
  },
  {
    name: 'S8 activity as a viewer',
    as: 'viewer',
    path: () => '/activity',
    ready: async (p) => {
      await h1(p, 'Activity');
      await expect(p.getByRole('list', { name: 'Upcoming deploys' })).toBeVisible();
    },
  },
  {
    name: 'S8 activity, filtered to nothing',
    as: 'admin',
    path: () => '/activity?requester=nobody-at-all',
    ready: async (p) => {
      await h1(p, 'Activity');
      await expect(p.getByRole('heading', { name: 'Nothing matches' })).toBeVisible();
    },
  },
  {
    name: 'S8 activity, a rollout opened',
    as: 'admin',
    path: () => '/activity',
    ready: (p) => h1(p, 'Activity'),
    act: async (p) => {
      const toggle = p.getByRole('button', { name: /^Deploy all ready · 2 apps/ });
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    },
  },
  {
    name: 'S9 activity › schedules',
    as: 'admin',
    path: () => '/activity?kind=schedule',
    ready: async (p) => {
      await h1(p, 'Activity');
      await expect(p.getByRole('button', { name: /^Cancel / })).toBeVisible();
    },
  },
  {
    name: 'S9 activity, schedule sheet',
    as: 'admin',
    path: () => '/activity',
    ready: (p) => h1(p, 'Activity'),
    act: async (p) => {
      await p.getByRole('button', { name: 'Schedule a deploy' }).click();
      await dialog(p, 'Schedule a deploy');
    },
  },
  {
    name: 'S9 activity, cancel a schedule confirm',
    as: 'admin',
    path: () => '/activity?kind=schedule',
    ready: async (p) => {
      await h1(p, 'Activity');
      await expect(p.getByRole('button', { name: /^Cancel / })).toBeVisible();
    },
    act: async (p) => {
      await p.getByRole('button', { name: /^Cancel / }).click();
      await dialog(p, /^Cancel the deploy of/);
    },
  },
  // S12 Settings › Host (SHP-T-13.6): the health checklist and, rarely needed, agent enrolment.
  {
    name: 'S12 settings › host',
    as: 'admin',
    path: () => '/settings/host',
    ready: async (p) => {
      await h1(p, 'Host');
      await expect(p.getByRole('list', { name: 'Host health' })).toBeVisible();
      // An agent awaits its fingerprint, so enrolment starts open.
      await expect(p.getByRole('button', { name: 'Revoke agent' })).toBeVisible();
    },
  },
  {
    name: 'S12 settings › host, revoke agent confirm',
    as: 'admin',
    path: () => '/settings/host',
    ready: async (p) => {
      await h1(p, 'Host');
      await expect(p.getByRole('button', { name: 'Revoke agent' })).toBeVisible();
    },
    act: async (p) => {
      await p.getByRole('button', { name: 'Revoke agent' }).click();
      await dialog(p, 'Revoke this agent?');
    },
  },
  {
    name: 'S12 settings › host, renew the agent’s token',
    as: 'admin',
    path: () => '/settings/host',
    ready: (p) => h1(p, 'Host'),
    act: async (p) => {
      await p.getByRole('button', { name: 'Renew…' }).click();
      await dialog(p, "Renew the agent's GitHub token");
    },
  },
  // S11 Settings › Claude & tokens: Connect first, one token form, then the list.
  {
    name: 'S11 settings › claude & tokens',
    as: 'admin',
    path: () => '/settings/tokens',
    ready: async (p) => {
      await h1(p, 'Claude & tokens');
      await expect(p.getByRole('list', { name: 'API tokens' }).getByText('matdemers1/d3-auth')).toBeVisible();
    },
  },
  {
    name: 'S11 settings › claude & tokens as a viewer',
    as: 'viewer',
    path: () => '/settings/tokens',
    ready: async (p) => {
      await h1(p, 'Claude & tokens');
      await expect(p.getByText('A deployer makes the token')).toBeVisible();
    },
  },
  {
    name: 'S11 settings › claude & tokens, revoke confirm',
    as: 'admin',
    path: () => '/settings/tokens',
    ready: async (p) => {
      await h1(p, 'Claude & tokens');
      await expect(p.getByRole('list', { name: 'API tokens' }).getByText('matdemers1/d3-auth')).toBeVisible();
    },
    act: async (p) => {
      await p.getByRole('button', { name: /^Revoke / }).first().click();
      await dialog(p, 'Revoke this token?');
    },
  },
  {
    name: 'S11 settings › claude & tokens, token made and waiting for the first call',
    as: 'admin',
    path: () => '/settings/tokens',
    ready: (p) => h1(p, 'Claude & tokens'),
    act: async (p) => {
      const form = p.getByRole('form', { name: 'Make a token' });
      await form.getByRole('textbox', { name: 'Name' }).fill('console-e2e-a11y-token');
      await form.getByRole('checkbox', { name: 'All apps' }).check();
      await form.getByRole('button', { name: 'Make the token' }).click();
      await expect(p.getByRole('button', { name: 'Copy token' })).toBeVisible();
      await expect(p.getByText('Waiting for Claude Code’s first call…')).toBeVisible();
    },
  },
  // S13 Settings › People: users and invites, and your own account.
  {
    name: 'S13 settings › people',
    as: 'admin',
    path: () => '/settings/people',
    ready: async (p) => {
      await h1(p, 'People');
      // Twice once the invite scenario has run: the invite, and the pending account it made.
      await expect(p.getByText('newcomer@shipyard.test').first()).toBeVisible();
    },
  },
  {
    name: 'S13 settings › people, invite link shown once',
    as: 'admin',
    path: () => '/settings/people',
    ready: async (p) => {
      await h1(p, 'People');
      await expect(p.getByText('newcomer@shipyard.test').first()).toBeVisible();
    },
    act: async (p) => {
      await p.getByRole('textbox', { name: 'Email' }).fill('console-e2e-a11y-invite@shipyard.test');
      await p.getByRole('button', { name: 'Create invite' }).click();
      await expect(p.getByText(/^Invite for console-e2e-a11y-invite@shipyard\.test created$/)).toBeVisible();
      await expect(p.getByRole('button', { name: 'Copy link' })).toBeVisible();
    },
  },
  {
    name: 'S14 settings › people as a viewer (your account)',
    as: 'viewer',
    path: () => '/settings/people',
    ready: async (p) => {
      await h1(p, 'People');
      await expect(p.getByRole('heading', { name: 'Your account' })).toBeVisible();
    },
  },
  // S16 Settings › Integrations (admin only): the cards, each form opened in place, a failed test,
  // the turn-off confirms, and a viewer refused.
  {
    name: 'S16 settings › integrations',
    as: 'admin',
    path: () => '/settings/integrations',
    ready: async (p) => {
      await h1(p, 'Integrations');
      await expect(p.getByRole('button', { name: /^(Set up|Edit) Sign in with D3 Auth$/ })).toBeVisible();
      await expect(p.getByRole('button', { name: /^(Set up|Edit) alert email$/ })).toBeVisible();
    },
  },
  {
    name: 'S16 settings › integrations, D3 Auth opened',
    as: 'admin',
    path: () => '/settings/integrations',
    ready: (p) => h1(p, 'Integrations'),
    act: async (p) => {
      await openD3Auth(p);
      await expect(p.getByRole('button', { name: 'Download app manifest', exact: true })).toBeVisible();
    },
  },
  {
    name: 'S16 settings › integrations, a failed D3 Auth test',
    as: 'admin',
    path: () => '/settings/integrations',
    ready: (p) => h1(p, 'Integrations'),
    act: async (p) => {
      await openD3Auth(p);
      await p.getByRole('textbox', { name: 'Issuer' }).fill('http://127.0.0.1:9');
      await p.getByRole('button', { name: 'Test', exact: true }).click();
      await expect(p.getByText('The issuer did not pass')).toBeVisible();
    },
  },
  {
    name: 'S16 settings › integrations, D3 Auth turn-off confirm',
    as: 'admin',
    path: () => '/settings/integrations',
    ready: (p) => h1(p, 'Integrations'),
    act: async (p) => {
      // An issuer nothing answers: saved, the button stays off, and Turn off appears.
      await openD3Auth(p);
      await p.getByRole('textbox', { name: 'Issuer' }).fill('http://127.0.0.1:9');
      await p.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(p.getByText('Configured, but the D3 Auth button is off')).toBeVisible();
      await p.getByRole('button', { name: 'Turn off', exact: true }).click();
      await dialog(p, 'Turn off Sign in with D3 Auth?');
    },
  },
  {
    name: 'S16 settings › integrations, GitHub opened',
    as: 'admin',
    path: () => '/settings/integrations',
    ready: (p) => h1(p, 'Integrations'),
    act: async (p) => {
      await p.getByRole('button', { name: /^(Add a|Edit) GitHub token$/ }).click();
      await expect(p.getByRole('form', { name: 'GitHub access' })).toBeVisible();
    },
  },
  {
    name: 'S16 settings › integrations, alert email test failed',
    as: 'admin',
    path: () => '/settings/integrations',
    ready: (p) => h1(p, 'Integrations'),
    act: async (p) => {
      // A relay nothing answers: saved, and the test says it could not connect.
      await saveDeadRelay(p);
      await p.getByRole('button', { name: 'Send test email', exact: true }).click();
      await expect(p.getByText('The relay did not send it')).toBeVisible();
    },
  },
  {
    name: 'S16 settings › integrations, alert email turn-off confirm',
    as: 'admin',
    path: () => '/settings/integrations',
    ready: (p) => h1(p, 'Integrations'),
    act: async (p) => {
      await saveDeadRelay(p);
      await p.getByRole('button', { name: 'Turn off alert email', exact: true }).click();
      await dialog(p, 'Turn off alert email?');
    },
  },
  {
    name: 'S16 settings › integrations as a viewer, denied',
    as: 'viewer',
    path: () => '/settings/integrations',
    ready: (p) => expect(p.getByRole('heading', { name: 'This page needs the admin role' })).toBeVisible(),
  },
  // S16 Settings › Builds (admin only): collapsed while no app builds with Shipyard, and opened.
  {
    name: 'S16 settings › builds',
    as: 'admin',
    path: () => '/settings/builds',
    ready: async (p) => {
      await h1(p, 'Builds');
      await expect(p.getByRole('button', { name: 'Edit limits' })).toBeVisible();
    },
  },
  {
    name: 'S16 settings › builds, limits opened',
    as: 'admin',
    path: () => '/settings/builds',
    ready: (p) => h1(p, 'Builds'),
    act: async (p) => {
      await p.getByRole('button', { name: 'Edit limits' }).click();
      await expect(p.getByRole('form', { name: 'Builds' })).toBeVisible();
    },
  },
  // Invite acceptance — the form, its authenticator step, and a dead link.
  {
    name: 'invite acceptance',
    as: null,
    path: (fx) => `/invite/${fx.inviteToken}`,
    ready: async (p) => {
      await h1(p, 'Join Shipyard');
      await expect(p.getByText('newcomer@shipyard.test')).toBeVisible();
    },
  },
  {
    name: 'invite acceptance, authenticator step',
    as: null,
    path: (fx) => `/invite/${fx.inviteToken}`,
    ready: (p) => expect(p.getByText('newcomer@shipyard.test')).toBeVisible(),
    act: async (p) => {
      await p.getByRole('textbox', { name: 'Display name' }).fill('New Comer');
      await p.getByLabel('Password', { exact: true }).fill('console-e2e-newcomer-password');
      await p.getByRole('button', { name: 'Continue' }).click();
      await expect(p.getByText('Add your authenticator')).toBeVisible();
    },
  },
  {
    name: 'invite acceptance, invalid link',
    as: null,
    path: () => `/invite/inv_${'x'.repeat(43)}`,
    ready: (p) => h1(p, 'Join Shipyard'),
  },
  // First-run setup (SHP-REQ-109), on a server with no account — the form and its authenticator step.
  {
    name: 'first-run setup',
    as: null,
    zeroUsers: true,
    path: () => '/',
    ready: (p) => h1(p, 'Set up Shipyard'),
  },
  {
    name: 'first-run setup, authenticator step',
    as: null,
    zeroUsers: true,
    path: () => '/setup',
    ready: (p) => h1(p, 'Set up Shipyard'),
    act: async (p) => {
      await p.getByRole('textbox', { name: 'Email' }).fill('first-admin@shipyard.test');
      await p.getByRole('textbox', { name: 'Display name' }).fill('Fay First');
      await p.getByLabel('Password', { exact: true }).fill('console-e2e-first-admin-password');
      await p.getByLabel('Confirm password', { exact: true }).fill('console-e2e-first-admin-password');
      await p.getByRole('button', { name: 'Continue' }).click();
      await expect(p.getByRole('heading', { level: 1, name: 'Add your authenticator' })).toBeVisible();
    },
  },
  // Not found.
  {
    name: 'not found',
    as: 'admin',
    path: () => '/no-such-page',
    ready: (p) => expect(p.getByRole('heading', { name: 'There is no page at this address' })).toBeVisible(),
  },
];

for (const width of ['desktop', 'phone'] as const satisfies readonly Width[]) {
  for (const theme of ['light', 'dark'] as const satisfies readonly Theme[]) {
    test.describe(`axe — ${theme}, ${width === 'phone' ? '390 px' : '1440 px'}`, () => {
      for (const screen of SCREENS.filter((s) => s.only === undefined || s.only === width)) {
        test.describe(() => {
          test.use({
            storageState: screen.as === null ? { cookies: [], origins: [] } : storageStateFor(screen.as),
            ...useWidth(width),
          });

          test(`${screen.name} has no serious or critical violations`, async ({ page }) => {
            const snapshot = screen.zeroUsers === true ? await withDb((db) => enterZeroUserWorld(db)) : undefined;
            const world = screen.world;
            if (world !== undefined) await withDb((db) => world(db));
            try {
              await check(page, screen, theme, width);
            } finally {
              if (snapshot !== undefined) await withDb((db) => restoreAccounts(db, snapshot));
              if (world !== undefined) await withDb((db) => reseedWorld(db));
            }
          });
        });
      }
    });
  }
}

/** One screen in one theme at one width: go there, wait for it, open what it is about, run axe. */
async function check(page: Page, screen: Screen, theme: Theme, width: Width): Promise<void> {
  const ctx: Ctx = { fx: fixture(), phone: width === 'phone' };
  await forceTheme(page, theme);
  await page.goto(screen.path(ctx.fx));
  await expectTheme(page, theme);
  await screen.ready(page, ctx);
  await settle(page);
  if (screen.act !== undefined) {
    await screen.act(page, ctx);
    await settle(page);
  }

  const label = `${screen.name} (${theme}, ${width})`;
  const { blocking, other } = await axeViolations(page);
  if (other.length > 0) {
    test.info().annotations.push({ type: 'axe (moderate/minor)', description: other.join('\n') });
  }
  expect(blocking, `${label}:\n  ${blocking.join('\n  ')}`).toEqual([]);
  if (ctx.phone) await expectPhoneFit(page, label);
}

/**
 * A few scenarios above (making an API token, creating an invite, saving a dead issuer or relay)
 * change the seeded world. `reseedWorld` puts the baseline — every app, deploy, token, invite and
 * agent — back once the whole sweep is done, so whatever runs after this file starts from the same
 * world it would have without this suite.
 */
test.afterAll(async () => {
  await withDb((db) => reseedWorld(db));
  // The turn-off-confirm scenario leaves a (dead) issuer saved; clearing it through the API also
  // swaps the server's live client back.
  await clearD3AuthSetting();
  await clearMailSetting();
});

/** The sweep above passing means nothing unless axe would have failed it: prove the check bites. */
test.describe('the check itself', () => {
  test.use({ storageState: storageStateFor('admin') });

  test('a serious violation on a screen fails it', async ({ page }) => {
    await page.goto('/');
    await h1(page, 'Apps');
    await page.evaluate(() => {
      const button = document.createElement('button');
      button.id = 'console-e2e-unnamed';
      document.querySelector('main')?.append(button);
    });
    const { blocking } = await axeViolations(page);
    expect(blocking.join('\n')).toContain('button-name (critical)');
  });
});
