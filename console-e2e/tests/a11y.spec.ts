import { expect, test, type Page } from '@playwright/test';
import { axeViolations, expectTheme, forceTheme, settle, type Theme } from '../harness/a11y.js';
import { USERS, storageStateFor, type RoleName } from '../harness/env.js';
import { fixture, type Fixture } from '../harness/seed.js';

/**
 * SHP-T-6.2, SHP-REQ-090: every screen, in both themes, has no serious or critical axe violation.
 *
 * "Every screen" is every route in apps/web/src/routes.tsx, plus the states of a screen that put
 * different things in front of a person — each sheet open, an app never deployed, drifted, frozen,
 * a deploy succeeded, rolled back and refused, the viewer's denied page, the phone-width drawer.
 * Each is checked in light *and* dark, because a contrast failure only exists in one of them.
 */

interface Screen {
  name: string;
  /** Who is signed in; null for the signed-out screens. */
  as: RoleName | null;
  path: (fx: Fixture) => string;
  /** Resolves once the screen shows its data (not its skeleton). */
  ready: (page: Page, fx: Fixture) => Promise<void>;
  /** After ready: open the sheet or menu this scenario is about. */
  act?: (page: Page, fx: Fixture) => Promise<void>;
  /** Phone width (the console is phone-first, 375 px). */
  phone?: boolean;
}

const h1 = (page: Page, name: string | RegExp) => expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
const dialog = async (page: Page, name: string | RegExp) => {
  await expect(page.getByRole('dialog', { name })).toBeVisible();
};

/** The home card for `app`. */
const card = (page: Page, app: string) => page.getByRole('listitem').filter({ has: page.getByRole('link', { name: app, exact: true }) });

const SCREENS: Screen[] = [
  // S1 Sign in — both steps.
  { name: 'S1 sign in', as: null, path: () => '/signin', ready: (p) => h1(p, 'Sign in to Shipyard') },
  {
    name: 'S1 sign in, authenticator step',
    as: null,
    path: () => '/signin',
    ready: (p) => h1(p, 'Sign in to Shipyard'),
    act: async (p) => {
      await p.getByRole('textbox', { name: 'Email' }).fill(USERS.viewer.email);
      await p.getByLabel('Password', { exact: true }).fill(USERS.viewer.password);
      await p.getByRole('button', { name: 'Continue' }).click();
      await expect(p.getByText('Authenticator code')).toBeVisible();
    },
  },
  // S2 Home.
  {
    name: 'S2 home',
    as: 'admin',
    path: () => '/',
    ready: async (p, fx) => {
      await h1(p, 'Home');
      await expect(card(p, fx.apps.history).getByRole('button', { name: /^Ship / })).toBeVisible();
    },
  },
  {
    name: 'S2 home as a viewer',
    as: 'viewer',
    path: () => '/',
    ready: async (p, fx) => {
      await h1(p, 'Home');
      await expect(card(p, fx.apps.history)).toBeVisible();
    },
  },
  {
    name: 'S2 home, account menu open',
    as: 'admin',
    path: () => '/',
    ready: (p) => h1(p, 'Home'),
    act: async (p) => {
      await p.getByRole('button', { name: new RegExp(USERS.admin.displayName) }).click();
      await expect(p.getByRole('menuitem', { name: 'Account' })).toBeVisible();
    },
  },
  {
    name: 'S2 home at phone width, navigation open',
    as: 'admin',
    phone: true,
    path: () => '/',
    ready: (p) => h1(p, 'Home'),
    act: async (p) => {
      await p.getByRole('button', { name: 'Open navigation' }).click();
      await expect(p.getByRole('link', { name: 'Timeline' })).toBeVisible();
    },
  },
  // S3 Dry-run sheet — a deploy, an approval review, and a group deploy.
  {
    name: 'S3 dry-run sheet, deploy',
    as: 'admin',
    path: () => '/',
    ready: (p) => h1(p, 'Home'),
    act: async (p, fx) => {
      await card(p, fx.apps.history).getByRole('button', { name: /^Ship / }).click();
      await dialog(p, `Deploy ${fx.apps.history}`);
    },
  },
  {
    name: 'S3 dry-run sheet, approval review',
    as: 'admin',
    path: () => '/',
    ready: (p) => h1(p, 'Home'),
    act: async (p, fx) => {
      await p.getByRole('button', { name: 'Review' }).click();
      await dialog(p, `Approve deploy of ${fx.apps.approval}`);
    },
  },
  {
    name: 'S3 group deploy sheet',
    as: 'admin',
    path: () => '/',
    ready: (p) => h1(p, 'Home'),
    act: async (p, fx) => {
      await p.getByRole('button', { name: 'Deploy group' }).click();
      await expect(p.getByRole('dialog')).toContainText(fx.group);
    },
  },
  {
    name: 'S2 deny-approval confirm',
    as: 'admin',
    path: () => '/',
    ready: (p) => h1(p, 'Home'),
    act: async (p, fx) => {
      await p.getByRole('button', { name: 'Deny' }).click();
      await dialog(p, new RegExp(`^Deny ${fx.apps.approval}`));
    },
  },
  // S4 Deploy progress — live, and finished.
  {
    name: 'S4 deploy progress, soaking',
    as: 'admin',
    path: (fx) => `/deploys/${fx.deploys.inProgress}/live`,
    ready: async (p) => {
      await expect(p.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(p.getByText(/requested by/)).toBeVisible();
    },
  },
  {
    name: 'S4 deploy progress, rolled back',
    as: 'admin',
    path: (fx) => `/deploys/${fx.deploys.rolledBack}/live`,
    ready: async (p) => {
      await expect(p.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(p.getByText(/requested by/)).toBeVisible();
    },
  },
  // S5 App detail — every variant.
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
      name: `S5 app detail, ${variant}`,
      as: 'admin',
      path: (fx) => `/apps/${app(fx)}`,
      ready: async (p, fx) => {
        await h1(p, app(fx));
        await expect(p.getByRole('heading', { name: 'Manifest' })).toBeVisible();
      },
    }),
  ),
  {
    name: 'S5 app detail as a viewer',
    as: 'viewer',
    path: (fx) => `/apps/${fx.apps.history}`,
    ready: async (p, fx) => {
      await h1(p, fx.apps.history);
      await expect(p.getByRole('heading', { name: 'Manifest' })).toBeVisible();
    },
  },
  {
    name: 'S5 app detail, no such app',
    as: 'admin',
    path: () => '/apps/no-such-app',
    ready: (p) => expect(p.getByText('No app named no-such-app.')).toBeVisible(),
  },
  {
    name: 'S5 app detail, rollback sheet',
    as: 'admin',
    path: (fx) => `/apps/${fx.apps.history}`,
    ready: (p, fx) => h1(p, fx.apps.history),
    act: async (p, fx) => {
      await p.getByRole('button', { name: /^Roll back/ }).first().click();
      await dialog(p, `Roll back ${fx.apps.history}`);
    },
  },
  // S6 Deploy record.
  ...(['succeeded', 'rolledBack', 'refused', 'awaitingApproval'] as const).map(
    (which): Screen => ({
      name: `S6 deploy record, ${which}`,
      as: 'admin',
      path: (fx) => `/deploys/${fx.deploys[which]}`,
      ready: async (p) => {
        await expect(p.getByRole('heading', { level: 1 })).toContainText('·');
      },
    }),
  ),
  // S7 Restore, and its typed confirmation.
  {
    name: 'S7 restore',
    as: 'admin',
    path: (fx) => `/apps/${fx.apps.history}/restore`,
    ready: async (p, fx) => {
      await h1(p, `Restore ${fx.apps.history}`);
      await expect(p.getByRole('button', { name: /^Restore the backup taken/ }).first()).toBeVisible();
    },
  },
  {
    name: 'S7 restore, confirm sheet',
    as: 'admin',
    path: (fx) => `/apps/${fx.apps.history}/restore`,
    ready: (p, fx) => h1(p, `Restore ${fx.apps.history}`),
    act: async (p, fx) => {
      await p.getByRole('button', { name: /^Restore the backup taken/ }).first().click();
      await dialog(p, `Restore ${fx.apps.history}`);
    },
  },
  {
    name: 'S7 restore, never deployed',
    as: 'admin',
    path: (fx) => `/apps/${fx.apps.neverDeployed}/restore`,
    ready: (p, fx) => h1(p, `Restore ${fx.apps.neverDeployed}`),
  },
  // S8 Timeline.
  {
    name: 'S8 timeline',
    as: 'admin',
    path: () => '/timeline',
    ready: async (p, fx) => {
      await h1(p, 'Timeline');
      await expect(p.getByText(fx.apps.history).first()).toBeVisible();
    },
  },
  {
    name: 'S8 timeline, filtered to nothing',
    as: 'admin',
    path: () => '/timeline?requester=nobody-at-all',
    ready: (p) => h1(p, 'Timeline'),
  },
  // S9 Schedules, and the schedule sheet.
  {
    name: 'S9 schedules',
    as: 'admin',
    path: () => '/schedules',
    ready: async (p) => {
      await h1(p, 'Schedules');
      await expect(p.getByRole('button', { name: /^Cancel / })).toBeVisible();
    },
  },
  {
    name: 'S9 schedules, schedule sheet',
    as: 'admin',
    path: () => '/schedules',
    ready: (p) => h1(p, 'Schedules'),
    act: async (p) => {
      await p.getByRole('button', { name: 'Schedule a deploy' }).click();
      await dialog(p, 'Schedule a deploy');
    },
  },
  // S10 Freeze sheet.
  {
    name: 'S10 freeze sheet',
    as: 'admin',
    path: (fx) => `/apps/${fx.apps.history}`,
    ready: (p, fx) => h1(p, fx.apps.history),
    act: async (p, fx) => {
      await p.getByRole('button', { name: 'Freeze', exact: true }).click();
      await dialog(p, `Freeze ${fx.apps.history}`);
    },
  },
  // S11 API tokens.
  {
    name: 'S11 API tokens',
    as: 'admin',
    path: () => '/tokens',
    ready: async (p) => {
      await h1(p, 'API tokens');
      await expect(p.getByText('matdemers1/d3-auth')).toBeVisible();
    },
  },
  {
    name: 'S11 API tokens, denied to a viewer',
    as: 'viewer',
    path: () => '/tokens',
    ready: (p) => expect(p.getByText('This page needs the deployer role')).toBeVisible(),
  },
  // S12 Agent.
  {
    name: 'S12 agent',
    as: 'admin',
    path: () => '/agent',
    ready: async (p) => {
      await h1(p, 'Agent');
      await expect(p.getByRole('button', { name: 'Revoke agent' })).toBeVisible();
    },
  },
  // S13 Users and invites.
  {
    name: 'S13 users and invites',
    as: 'admin',
    path: () => '/users',
    ready: async (p) => {
      await h1(p, 'Users');
      // Twice once the invite scenario has run: the invite, and the pending account it made.
      await expect(p.getByText('newcomer@shipyard.test').first()).toBeVisible();
    },
  },
  // S14 Account.
  { name: 'S14 account', as: 'admin', path: () => '/account', ready: (p) => h1(p, 'Account') },
  { name: 'S14 account as a viewer', as: 'viewer', path: () => '/account', ready: (p) => h1(p, 'Account') },
  // S15 System.
  {
    name: 'S15 system',
    as: 'admin',
    path: () => '/system',
    ready: async (p) => {
      await h1(p, 'System');
      await expect(p.getByText('0.6.0').first()).toBeVisible();
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
  // Not found.
  {
    name: 'not found',
    as: 'admin',
    path: () => '/no-such-page',
    ready: (p) => expect(p.getByRole('heading', { name: 'There is no page at this address' })).toBeVisible(),
  },
];

for (const theme of ['light', 'dark'] as const satisfies readonly Theme[]) {
  test.describe(`axe — ${theme}`, () => {
    for (const screen of SCREENS) {
      test.describe(() => {
        test.use({
          storageState: screen.as === null ? { cookies: [], origins: [] } : storageStateFor(screen.as),
          ...(screen.phone === true ? { viewport: { width: 375, height: 812 } } : {}),
        });

        test(`${screen.name} has no serious or critical violations`, async ({ page }) => {
          const fx = fixture();
          await forceTheme(page, theme);
          await page.goto(screen.path(fx));
          await expectTheme(page, theme);
          await screen.ready(page, fx);
          await settle(page);
          if (screen.act !== undefined) {
            await screen.act(page, fx);
            await settle(page);
          }

          const { blocking, other } = await axeViolations(page);
          if (other.length > 0) {
            test.info().annotations.push({ type: 'axe (moderate/minor)', description: other.join('\n') });
          }
          expect(blocking, `${screen.name} (${theme}):\n  ${blocking.join('\n  ')}`).toEqual([]);
        });
      });
    }
  });
}

/** The sweep above passing means nothing unless axe would have failed it: prove the check bites. */
test.describe('the check itself', () => {
  test.use({ storageState: storageStateFor('admin') });

  test('a serious violation on a screen fails it', async ({ page }) => {
    await page.goto('/');
    await h1(page, 'Home');
    await page.evaluate(() => {
      const button = document.createElement('button');
      button.id = 'console-e2e-unnamed';
      document.querySelector('main')?.append(button);
    });
    const { blocking } = await axeViolations(page);
    expect(blocking.join('\n')).toContain('button-name (critical)');
  });
});
