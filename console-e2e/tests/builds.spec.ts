import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { axeViolations, expectTheme, forceTheme, settle, type Theme } from '../harness/a11y.js';
import { expectPhoneFit, useWidth, type Width } from '../harness/console.js';
import { withDb, type Db } from '../harness/db.js';
import { storageStateFor } from '../harness/env.js';
import { MINUTE, ago, digest, fixture, sha } from '../harness/seed.js';

/**
 * SHP-T-7.12, SHP-REQ-142, SHP-REQ-143: builds in Activity (the Builds list became Activity's
 * Builds view, SHP-T-13.13) and a build's own page, against the real server. A deployer goes
 * Activity › Builds → a build, watches the log grow over SSE, cancels the build (it stops at its
 * next stage boundary), and rebuilds it; a viewer sees neither button. Both screens are axe-clean
 * in light and dark, at 390 px on a touch phone and at 1440 px.
 *
 * No agent runs in this harness, so a build's progress is written the way the agent's reports
 * would leave it — straight through the server's Prisma client. The live stream re-reads the
 * database on every wake-up and on its idle keep-alive, so a chunk written here reaches the page
 * over the same SSE connection within one keep-alive (15 s).
 */

const APP = 'forge';
const STREAM_WAIT = { timeout: 25_000 };

interface Built {
  appId: string;
  /** Running: the list → detail → live log → cancel → rebuild flow. */
  flow: string;
  flowSha: string;
  /** Running, left alone: the viewer's view and the axe sweep. */
  live: string;
  /** Succeeded with digests. */
  succeeded: string;
  /** Failed at test, with a refusal. */
  failed: string;
}

let built: Built;

/** A manifest the server's build service accepts: `build.source: shipyard` for every service. */
function manifest(): Record<string, unknown> {
  return {
    name: APP,
    repo: `matdemers1/${APP}`,
    defaultBranch: 'main',
    workflow: 'ci.yml',
    compose: { project: APP, files: [`/srv/${APP}/docker-compose.yml`] },
    services: { server: { image: `ghcr.io/matdemers1/${APP}/server` } },
    health: { service: 'server', port: 8080, path: '/health' },
    soakSeconds: 60,
    approval: 'none',
    diskFloorGb: 5,
    retainImages: 3,
    build: { source: 'shipyard', releaseTargets: { server: 'release' } },
  };
}

async function createBuild(
  db: Db,
  appId: string,
  spec: {
    sha: string;
    state: 'running' | 'succeeded' | 'failed';
    stages: { stage: 'fetch' | 'test' | 'integration' | 'build' | 'push'; state: 'running' | 'succeeded' | 'failed' | 'skipped' }[];
    logs: { stage: 'fetch' | 'test' | 'integration' | 'build' | 'push'; chunk: string }[];
    digests?: Record<string, string>;
    refusal?: { code: string; gate: string; message: string; fix: string };
    failedStage?: 'test';
  },
): Promise<string> {
  const startedAt = ago(5 * MINUTE);
  const ended = spec.state !== 'running';
  const row = await db.build.create({
    data: {
      appId,
      sha: spec.sha,
      state: spec.state,
      trigger: 'webhook',
      requesterLabel: 'push to main',
      dispatchedAt: startedAt,
      startedAt,
      endedAt: ended ? ago(MINUTE) : null,
      createdAt: new Date(startedAt.getTime() - 5_000),
      ...(spec.digests !== undefined ? { digests: spec.digests } : {}),
      ...(spec.refusal !== undefined ? { refusal: spec.refusal } : {}),
      ...(spec.failedStage !== undefined ? { failedStage: spec.failedStage } : {}),
    },
    select: { id: true },
  });
  let at = startedAt.getTime();
  for (const s of spec.stages) {
    await db.buildStageRun.create({
      data: {
        buildId: row.id,
        stage: s.stage,
        state: s.state,
        startedAt: new Date(at),
        endedAt: s.state === 'running' ? null : new Date(at + 20_000),
      },
    });
    at += 20_000;
  }
  for (const l of spec.logs) await db.buildLog.create({ data: { buildId: row.id, stage: l.stage, chunk: l.chunk } });
  return row.id;
}

test.beforeAll(async () => {
  const fx = fixture();
  built = await withDb(async (db) => {
    const json = JSON.stringify(manifest());
    const app = await db.app.create({
      data: {
        name: APP,
        agentId: fx.agentId,
        manifestYaml: json,
        manifestSha256: createHash('sha256').update(json).digest('hex'),
        repo: `matdemers1/${APP}`,
        defaultBranch: 'main',
        services: { server: { image: `ghcr.io/matdemers1/${APP}/server` } },
        soakSeconds: 60,
        approvalPolicy: 'none',
        reportedAt: new Date(),
        runningDigests: { server: digest(`${APP}/server@live`) },
      },
      select: { id: true },
    });
    const flowSha = sha(9001);
    const running = (s: string) => ({
      sha: s,
      state: 'running' as const,
      stages: [
        { stage: 'fetch' as const, state: 'succeeded' as const },
        { stage: 'test' as const, state: 'running' as const },
      ],
      logs: [
        { stage: 'fetch' as const, chunk: `fetched ${s.slice(0, 7)} into a fresh checkout\n` },
        { stage: 'test' as const, chunk: 'RUN pnpm test\n' },
        {
          stage: 'test' as const,
          // One unbroken line far wider than a phone: it must wrap, not widen the page.
          chunk: `${'a-very-long-token-without-any-spaces-'.repeat(8)}end\n`,
        },
      ],
    });
    return {
      appId: app.id,
      flowSha,
      flow: await createBuild(db, app.id, running(flowSha)),
      live: await createBuild(db, app.id, running(sha(9002))),
      succeeded: await createBuild(db, app.id, {
        sha: sha(9003),
        state: 'succeeded',
        stages: (['fetch', 'test', 'integration', 'build', 'push'] as const).map((stage) => ({ stage, state: 'succeeded' as const })),
        logs: [
          { stage: 'build', chunk: 'exporting layers\n' },
          { stage: 'push', chunk: 'pushed ghcr.io/matdemers1/forge/server\n' },
        ],
        digests: { server: digest(`${APP}/server@9003`) },
      }),
      failed: await createBuild(db, app.id, {
        sha: sha(9004),
        state: 'failed',
        stages: [
          { stage: 'fetch', state: 'succeeded' },
          { stage: 'test', state: 'failed' },
        ],
        logs: [{ stage: 'test', chunk: '1 test failed\n' }],
        failedStage: 'test',
        refusal: { code: 'step_failed', gate: 'none', message: 'The test stage exited 1.', fix: 'Fix the failing test and push again.' },
      }),
    };
  });
});

test.afterAll(async () => {
  await withDb(async (db) => {
    await db.build.updateMany({ where: { appId: built.appId }, data: { rebuildOfId: null } });
    await db.build.deleteMany({ where: { appId: built.appId } });
    await db.app.delete({ where: { id: built.appId } });
  });
});

const h1 = (page: Page, name: string | RegExp) => expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
const stage = (page: Page, name: string) =>
  page.getByRole('list', { name: 'Build stages' }).getByRole('listitem').filter({ has: page.locator('strong').getByText(name, { exact: true }) });
const buildLog = (page: Page) => page.getByTestId('build-log');
const title = (s: string) => `Build ${APP} ${s.slice(0, 7)}`;
/** A build's row in the Activity feed: the row is one link, "<app> <sha7> <what happened> …". */
const feedBuild = (page: Page, s: string) => page.locator('.shp-feed').getByRole('link', { name: new RegExp(`^${APP} ${s.slice(0, 7)} `) });

test.describe('a deployer', () => {
  test.use({ storageState: storageStateFor('admin') });

  test('list → detail → live log → cancel → rebuild', async ({ page }) => {
    test.setTimeout(120_000);

    // The list, reached from the navigation: Builds is a view of Activity since SHP-ADR-006.
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Activity/ }).click();
    await h1(page, 'Activity');
    await page.getByRole('button', { name: 'Builds', exact: true }).click();
    await expect(page).toHaveURL(/\/activity\?kind=build$/);
    await expect(page.getByRole('button', { name: 'Builds', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const feed = page.locator('.shp-feed');
    await expect(feedBuild(page, built.flowSha)).toBeVisible();
    await expect(feedBuild(page, built.flowSha)).toContainText('Building');
    await expect(feedBuild(page, sha(9003))).toContainText('Build passed');
    await expect(feedBuild(page, sha(9004))).toContainText('Build failed at test');
    // Builds alone: no deploy of the seeded apps is in this view.
    await expect(feed.getByText(fixture().apps.history)).toHaveCount(0);

    // The detail: five stages in order, what ran so far, and the log over the live stream.
    await feedBuild(page, built.flowSha).click();
    await h1(page, title(built.flowSha));
    await expect(page).toHaveURL(new RegExp(`/builds/${built.flow}$`));
    await expect(page.getByRole('list', { name: 'Build stages' }).getByRole('listitem')).toHaveText([
      /Fetch.*Succeeded/,
      /Test.*Running/,
      /Integration.*Waiting/,
      /Build.*Waiting/,
      /Push.*Waiting/,
    ]);
    await expect(buildLog(page)).toContainText('RUN pnpm test');
    await expect(page.locator('[data-transport="live"]')).toBeVisible();

    // Live: a chunk and a stage the "agent" reports now arrive on the open stream, no reload.
    await withDb(async (db) => {
      await db.buildStageRun.updateMany({ where: { buildId: built.flow, stage: 'test' }, data: { state: 'succeeded', endedAt: new Date() } });
      await db.buildStageRun.create({ data: { buildId: built.flow, stage: 'integration', state: 'running' } });
      await db.buildLog.create({ data: { buildId: built.flow, stage: 'integration', chunk: 'integration: 12 passed\n' } });
    });
    await expect(buildLog(page)).toContainText('integration: 12 passed', STREAM_WAIT);
    await expect(stage(page, 'Integration')).toContainText('Running');
    await expect(stage(page, 'Test')).toContainText('Succeeded');
    await expect(page.locator('[data-transport="live"]')).toBeVisible();

    // A running build offers Cancel, not Rebuild.
    await expect(page.getByRole('button', { name: 'Rebuild' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Cancel build' }).click();
    const dialog = page.getByRole('dialog', { name: 'Cancel this build?' });
    await expect(dialog).toBeVisible();
    // Keeping it changes nothing.
    await dialog.getByRole('button', { name: 'Keep building' }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Cancel build' }).click();
    await page.getByRole('dialog', { name: 'Cancel this build?' }).getByRole('button', { name: 'Cancel build' }).click();
    await expect(page.getByText('Cancel requested. The build stops at its next stage boundary.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel build' })).toHaveCount(0);
    // Focus lands on the state it changed, not on the page body.
    await expect(page.getByRole('group', { name: 'Build state' })).toBeFocused();
    await withDb(async (db) => {
      const row = await db.build.findUniqueOrThrow({ where: { id: built.flow }, select: { cancelRequestedAt: true, state: true } });
      expect(row.state).toBe('running');
      expect(row.cancelRequestedAt).not.toBeNull();
    });

    // The "agent" stops at the stage boundary; the page shows the build cancelled.
    await withDb(async (db) => {
      await db.buildStageRun.updateMany({ where: { buildId: built.flow, stage: 'integration' }, data: { state: 'succeeded', endedAt: new Date() } });
      await db.build.update({ where: { id: built.flow }, data: { state: 'cancelled', endedAt: new Date() } });
    });
    await expect(page.getByRole('group', { name: 'Build state' }).getByText('Cancelled', { exact: true })).toBeVisible(STREAM_WAIT);
    await expect(stage(page, 'Build')).toContainText('Did not run');
    await expect(page.getByText('Finished', { exact: true })).toBeVisible();

    // Rebuild: a new build of the same SHA, and the page follows it.
    await page.getByRole('button', { name: 'Rebuild' }).click();
    await expect(page).not.toHaveURL(new RegExp(`/builds/${built.flow}$`));
    await h1(page, title(built.flowSha));
    await expect(page.getByRole('group', { name: 'Build state' }).getByText('Queued', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'The earlier build' })).toHaveAttribute('href', `/builds/${built.flow}`);
    await expect(page.getByRole('button', { name: 'Cancel build' })).toBeVisible();
    const rebuiltId = new URL(page.url()).pathname.split('/').pop() ?? '';
    await withDb(async (db) => {
      const row = await db.build.findUniqueOrThrow({ where: { id: rebuiltId }, select: { sha: true, trigger: true, rebuildOfId: true, state: true } });
      expect(row).toEqual({ sha: built.flowSha, trigger: 'rebuild', rebuildOfId: built.flow, state: 'queued' });
    });

    // Cancelling a queued build ends it at once.
    await page.getByRole('button', { name: 'Cancel build' }).click();
    await page.getByRole('dialog', { name: 'Cancel this build?' }).getByRole('button', { name: 'Cancel build' }).click();
    await expect(page.getByRole('group', { name: 'Build state' }).getByText('Cancelled', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rebuild' })).toBeVisible();
  });

  test('a finished build shows its digests; a failed one its refusal; the app lists its builds', async ({ page }) => {
    await page.goto(`/builds/${built.succeeded}`);
    await h1(page, title(sha(9003)));
    await expect(page.getByText('Built and pushed')).toBeVisible();
    await expect(page.getByText(digest(`${APP}/server@9003`))).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rebuild' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel build' })).toHaveCount(0);

    await page.goto(`/builds/${built.failed}`);
    await expect(page.getByText('Failed at Test')).toBeVisible();
    await expect(page.getByText('The test stage exited 1.')).toBeVisible();
    await expect(page.getByText('Fix the failing test and push again.')).toBeVisible();

    // The app page's Deploys tab lists its recent builds, and links to all of them in Activity.
    await page.goto(`/apps/${APP}`);
    await h1(page, APP);
    await expect(page.getByRole('list', { name: 'Recent builds' }).getByRole('link', { name: `${APP} · ${sha(9003).slice(0, 7)}` })).toBeVisible();
    await page.getByRole('link', { name: `All builds of ${APP}` }).click();
    await expect(page).toHaveURL(new RegExp(`/activity\\?kind=build&app=${APP}$`));
    await h1(page, 'Activity');
    await expect(feedBuild(page, sha(9003))).toBeVisible();
  });

  test('an app with no builds matches nothing when filtered, and an unknown build is not found', async ({ page }) => {
    const fx = fixture();
    await page.goto(`/builds?app=${fx.apps.history}`);
    await expect(page).toHaveURL(new RegExp(`/activity\\?kind=build&app=${fx.apps.history}$`));
    await expect(page.getByRole('heading', { name: 'Nothing matches' })).toBeVisible();
    await page.goto('/builds/00000000-0000-4000-8000-000000000000');
    await expect(page.getByRole('heading', { name: 'No such build.' })).toBeVisible();
  });
});

test.describe('a viewer', () => {
  test.use({ storageState: storageStateFor('viewer') });

  test('sees builds and their logs but no Rebuild or Cancel', async ({ page }) => {
    await page.goto('/builds');
    await h1(page, 'Activity');
    await expect(feedBuild(page, sha(9002))).toBeVisible();
    await page.goto(`/builds/${built.live}`);
    await h1(page, title(sha(9002)));
    await expect(buildLog(page)).toContainText('RUN pnpm test');
    await expect(page.getByRole('button', { name: 'Cancel build' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Rebuild' })).toHaveCount(0);

    await page.goto(`/builds/${built.succeeded}`);
    await expect(page.getByText('Built and pushed')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rebuild' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cancel build' })).toHaveCount(0);
  });
});

// ── axe: both screens, both themes, phone and desktop ─────────────────────

interface Screen {
  name: string;
  path: () => string;
  ready: (page: Page) => Promise<void>;
  act?: (page: Page) => Promise<void>;
}

const SCREENS: Screen[] = [
  {
    name: 'activity › builds',
    path: () => '/activity?kind=build',
    ready: async (p) => {
      await h1(p, 'Activity');
      await expect(feedBuild(p, sha(9003))).toBeVisible();
    },
  },
  {
    name: 'build detail, running with a live log',
    path: () => `/builds/${built.live}`,
    ready: async (p) => {
      await h1(p, title(sha(9002)));
      await expect(buildLog(p)).toContainText('RUN pnpm test');
    },
  },
  {
    name: 'build detail, cancel confirm',
    path: () => `/builds/${built.live}`,
    ready: (p) => h1(p, title(sha(9002))),
    act: async (p) => {
      await p.getByRole('button', { name: 'Cancel build' }).click();
      await expect(p.getByRole('dialog', { name: 'Cancel this build?' })).toBeVisible();
    },
  },
  {
    name: 'build detail, succeeded',
    path: () => `/builds/${built.succeeded}`,
    ready: async (p) => {
      await h1(p, title(sha(9003)));
      await expect(p.getByText('Built and pushed')).toBeVisible();
    },
  },
  {
    name: 'build detail, failed',
    path: () => `/builds/${built.failed}`,
    ready: async (p) => {
      await expect(p.getByText('Failed at Test')).toBeVisible();
    },
  },
];

for (const theme of ['light', 'dark'] as const satisfies readonly Theme[]) {
  for (const width of ['phone', 'desktop'] as const satisfies readonly Width[]) {
    const label = width === 'phone' ? '390 px' : '1440 px';
    test.describe(`axe — ${theme}, ${label}`, () => {
      test.use({ storageState: storageStateFor('admin'), ...useWidth(width) });

      for (const screen of SCREENS) {
        test(`${screen.name} has no serious or critical violations`, async ({ page }) => {
          await forceTheme(page, theme);
          await page.goto(screen.path());
          await expectTheme(page, theme);
          await screen.ready(page);
          await settle(page);
          if (screen.act !== undefined) {
            await screen.act(page);
            await settle(page);
          }
          const { blocking, other } = await axeViolations(page);
          if (other.length > 0) test.info().annotations.push({ type: 'axe (moderate/minor)', description: other.join('\n') });
          expect(blocking, `${screen.name} (${theme}, ${label}):\n  ${blocking.join('\n  ')}`).toEqual([]);
          // Nothing scrolls sideways at either width — the log wraps inside its own box — and on the
          // phone every primary action is a touch target.
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          expect(overflow).toBeLessThanOrEqual(0);
          if (width === 'phone') await expectPhoneFit(page, `${screen.name} (${theme}, ${label})`);
        });
      }
    });
  }
}
