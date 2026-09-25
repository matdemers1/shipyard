// The named export, not the default: under NodeNext the default resolves to the module namespace
// rather than the class (Foreman found this the hard way).
import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import type { NodeResult, Result } from 'axe-core';

/** The same rule set Foreman's sweep uses: WCAG 2.0 and 2.1, A and AA. */
export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** SHP-REQ-090: what fails the build. Moderate and minor findings are reported, not failed. */
export const BLOCKING_IMPACTS: readonly string[] = ['serious', 'critical'];

export type Theme = 'light' | 'dark';

/** The console's ThemeProvider storage key (apps/web/src/App.tsx). */
const THEME_STORAGE_KEY = 'shipyard.theme';

/**
 * Forces a theme before the page's first script runs: the stored preference *and* the OS scheme,
 * so neither "system" nor a stale choice can win. Call before the first `goto`.
 */
export async function forceTheme(page: Page, theme: Theme): Promise<void> {
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [THEME_STORAGE_KEY, theme] as const,
  );
}

/** The theme actually applied, or the check that forced it did nothing. */
export async function expectTheme(page: Page, theme: Theme): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

/**
 * Waits for the screen to stop moving: no skeletons, and every finite animation finished (a dialog
 * half-way through its fade-in fails contrast checks it would pass at rest). Spinners loop forever
 * and are left alone.
 */
export async function settle(page: Page): Promise<void> {
  await expect(page.locator('.d3-skl')).toHaveCount(0);
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => {
      const iterations = a.effect?.getComputedTiming().iterations;
      return iterations === Infinity || a.playState !== 'running';
    }),
  );
}

function describe(v: Result): string {
  const nodes = v.nodes
    .slice(0, 5)
    .map((n: NodeResult) => `${n.target.join(' ')}${n.failureSummary === undefined ? '' : `\n          ${n.failureSummary.replace(/\n/g, '\n          ')}`}`)
    .join('\n      ');
  return `${v.id} (${v.impact ?? 'unknown'}): ${v.help} — ${v.helpUrl}\n      ${nodes}`;
}

export interface AxeOptions {
  /**
   * Selectors axe skips. Only for a violation that lives inside @d3cloud/ui and cannot be fixed from
   * the app — each one names the upstream component in a comment where it is passed. Never a rule.
   */
  exclude?: readonly string[];
}

/** Runs axe on the page as it is now; returns every violation, described well enough to fix. */
export async function axeViolations(page: Page, options: AxeOptions = {}): Promise<{ blocking: string[]; other: string[] }> {
  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  for (const selector of options.exclude ?? []) builder = builder.exclude(selector);
  const results = await builder.analyze();
  const blocking = results.violations.filter((v) => BLOCKING_IMPACTS.includes(v.impact ?? ''));
  const other = results.violations.filter((v) => !BLOCKING_IMPACTS.includes(v.impact ?? ''));
  return { blocking: blocking.map(describe), other: other.map(describe) };
}
