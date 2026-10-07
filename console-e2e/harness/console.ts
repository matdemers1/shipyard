import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { USERS } from './env.js';

/**
 * What the specs share about the redesigned console (SHP-P-13): the two widths every screen is
 * checked at, finding a heading, a dialog or an app's row, holding or faking one API call, and the
 * phone checks — nothing scrolls sideways, and every primary action is a thumb's height.
 */

// ── Widths ─────────────────────────────────────────────────────────────────

/** A desktop window: the sidebar shows from 1024 px, and the app page's facts rail beside it. */
export const DESKTOP = { width: 1440, height: 900 } as const;

/**
 * A phone: 390 px wide, touch, and a mobile viewport, so the browser reports `(pointer: coarse)` and
 * @d3cloud/ui's 44 px touch-target rule applies (SHP-REQ-166).
 */
export const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } as const;

export type Width = 'desktop' | 'phone';

/** The context options for a width, for `test.use`. */
export function useWidth(width: Width) {
  return width === 'phone' ? PHONE : { viewport: DESKTOP };
}

// ── Finding things ─────────────────────────────────────────────────────────

export const h1 = (page: Page, name: string | RegExp) => expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

export const dialog = async (page: Page, name: string | RegExp): Promise<void> => {
  await expect(page.getByRole('dialog', { name })).toBeVisible();
};

/** An app's row in Apps › All apps (SHP-T-13.8), by the link that is its name. */
export const appRow = (page: Page, app: string): Locator =>
  page
    .getByRole('list', { name: 'All apps' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: app, exact: true }) });

/** Apps › Needs you, the list of what waits on a person. */
export const needsYou = (page: Page): Locator => page.getByRole('list', { name: 'Needs you' });

/** A row of Needs you, by the app it is about. */
export const needsYouRow = (page: Page, app: string): Locator => needsYou(page).getByRole('listitem').filter({ hasText: app });

/**
 * An Alert by its text. A static `@d3cloud/ui` Alert has no role (only a `dynamic` one is a live
 * region), so it is found by the design system's class.
 */
export const alertBox = (page: Page, text: string): Locator => page.locator('.d3-alrt').filter({ hasText: text });

/** "Deploy 1a2b3c4": the deploy verb with its short SHA (apps/web/src/lib/words.ts). */
export const DEPLOY_SHA = /^Deploy [0-9a-f]{7}$/;

// ── Network ────────────────────────────────────────────────────────────────

export const isPath = (path: string) => (url: URL) => url.pathname === path;

export const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Exactly the server's generic 500 (apps/server/src/errors.ts) — what a lost database answers. */
export const INTERNAL_ERROR = {
  error: { code: 'internal_error', gate: 'none', message: 'An unexpected error occurred.', fix: 'Try again; if this persists, contact an operator.' },
};

/** A route handler that holds the request until `release()` is called (then lets it through). */
export function hold(): { handler: (route: Route) => Promise<void>; release: () => void; seen: Promise<void> } {
  let release: () => void = () => undefined;
  let markSeen: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = new Promise<void>((resolve) => {
    markSeen = resolve;
  });
  return {
    handler: async (route) => {
      markSeen();
      await gate;
      await route.continue().catch(() => undefined);
    },
    release: () => {
      release();
    },
    seen,
  };
}

// ── The deploy sheet's fakes (no agent runs a dry run in this harness) ─────

export const FAKE_DRY_RUN = 'console-e2e-fake-dry-run';

/** Answers the sheet's dry-run POST with a fake deploy ID, and its poll with `status`. */
export async function fakeDryRun(page: Page, status: Record<string, unknown> | null): Promise<void> {
  await page.route(isPath('/api/deploys'), async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    return json(route, 202, { deployId: FAKE_DRY_RUN, state: 'queued' });
  });
  if (status !== null) {
    await page.route(isPath(`/api/deploys/${FAKE_DRY_RUN}`), (route) => json(route, 200, status));
  }
}

export function dryRunStatus(app: string, at: string, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    deployId: FAKE_DRY_RUN,
    kind: 'deploy',
    app,
    sha: at,
    dryRun: true,
    state: 'succeeded',
    currentStep: null,
    requester: { label: USERS.admin.displayName, repo: null, branch: null },
    images: [],
    schemaRevision: null,
    refusal: null,
    gates: ['G1', 'G2', 'G3', 'G4', 'G5'].map((gate) => ({ gate, pass: true, reason: 'ok' })),
    createdAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── The phone checks ───────────────────────────────────────────────────────

/** The smallest a primary action may be on a touch screen (SHP-REQ-166). */
export const TOUCH_TARGET_PX = 44;

/**
 * How far the document scrolls sideways (SHP-REQ-172: it must not), and the elements that stick out
 * past the right edge, deepest first, so a failure names what to fix.
 */
export async function sidewaysScroll(page: Page): Promise<{ overflow: number; culprits: string[] }> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const overflow = root.scrollWidth - root.clientWidth;
    if (overflow <= 0) return { overflow, culprits: [] };
    const edge = root.clientWidth + 0.5;
    const describe = (el: Element) => {
      const cls = typeof el.className === 'string' && el.className !== '' ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
      const text = el.textContent.trim().slice(0, 40);
      return `${el.tagName.toLowerCase()}${cls} (right ${String(Math.round(el.getBoundingClientRect().right))}) "${text}"`;
    };
    const wide = [...document.querySelectorAll('body *')].filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.right > edge;
    });
    // The deepest offenders: those with no offending descendant.
    const leaves = wide.filter((el) => !wide.some((other) => other !== el && el.contains(other)));
    return { overflow, culprits: leaves.slice(0, 8).map(describe) };
  });
}

/** Every visible primary button shorter than a touch target, described. */
export async function shortPrimaries(page: Page): Promise<string[]> {
  return page.evaluate((min) => {
    return [...document.querySelectorAll('.d3-btn--primary')]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      })
      .filter((el) => el.getBoundingClientRect().height < min - 0.5)
      .map((el) => `"${el.textContent.trim()}" is ${el.getBoundingClientRect().height.toFixed(1)} px tall`);
  }, TOUCH_TARGET_PX);
}

/** At 390 px: no sideways scroll and no primary action under 44 px (SHP-REQ-172, SHP-REQ-166). */
export async function expectPhoneFit(page: Page, where: string): Promise<void> {
  const { overflow, culprits } = await sidewaysScroll(page);
  expect(overflow, `${where} scrolls sideways by ${String(overflow)} px:\n  ${culprits.join('\n  ')}`).toBeLessThanOrEqual(0);
  const short = await shortPrimaries(page);
  expect(short, `${where}: primary actions under ${String(TOUCH_TARGET_PX)} px`).toEqual([]);
}
