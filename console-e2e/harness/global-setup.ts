import { mkdirSync } from 'node:fs';
import { chromium, type FullConfig } from '@playwright/test';
import { withDb } from './db.js';
import { BASE_URL, STATE_DIR, USERS, storageStateFor, type RoleName } from './env.js';
import { seedBaseline, writeFixture } from './seed.js';
import { signIn } from './sign-in.js';

/**
 * Runs once, after the webServer is up (so migrations have been applied): wipe and seed the
 * baseline, then sign each role in through the real form and keep its browser state.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  mkdirSync(STATE_DIR, { recursive: true });
  const fixture = await withDb((db) => seedBaseline(db));
  writeFixture(fixture);

  const baseURL = config.projects[0]?.use.baseURL ?? BASE_URL;
  const browser = await chromium.launch();
  try {
    for (const role of Object.keys(USERS) as RoleName[]) {
      const context = await browser.newContext({ baseURL });
      const page = await context.newPage();
      await signIn(page, USERS[role]);
      await context.storageState({ path: storageStateFor(role) });
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
