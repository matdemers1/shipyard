import type { RequestHandler, Response, Router } from 'express';
import type { z } from 'zod';
import { BuildSettings, BuildSettingsUpdate, DEFAULT_BUILD_SETTINGS } from '@shipyard/schema';
import type { Db } from '../db.js';

/**
 * Settings → Builds (SHP-REQ-131, SHP-REQ-132, SHP-T-7.11): the BuildKit container's CPU/memory
 * limits and the cache size cap, stored in the `setting` table under `build`. Nothing here talks
 * to Docker or BuildKit — that is the agent's job, which learns a change on its next poll
 * (`PollResponse.buildSettings`, wired in `agent/poll.ts`). Admin-only, audited like every other
 * setting; unlike Alert email and D3 Auth, there is no server.env override and no secret to seal.
 */

export const BUILD_SETTING_KEY = 'build';

/** `Setting.value` for `build`, or null when it does not shape a `BuildSettings`. */
export function parseStoredBuildSettings(value: unknown): BuildSettings | null {
  const parsed = BuildSettings.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** What Settings → Builds and the agent's poll both read: the saved limits, or the defaults. */
export async function loadBuildSettings(db: Db): Promise<BuildSettings> {
  const row = await db.setting.findUnique({ where: { key: BUILD_SETTING_KEY } });
  if (row === null) return DEFAULT_BUILD_SETTINGS;
  return parseStoredBuildSettings(row.value) ?? DEFAULT_BUILD_SETTINGS;
}

export interface BuildSettingsRouteDeps {
  db: Db;
}

export function addBuildRoutes(
  router: Router,
  deps: BuildSettingsRouteDeps,
  admin: RequestHandler[],
  bad: (res: Response, issues: z.core.$ZodIssue[]) => void,
): void {
  const { db } = deps;

  router.get('/builds', ...admin, async (_req, res) => {
    res.json(await loadBuildSettings(db));
  });

  router.put('/builds', ...admin, async (req, res) => {
    const parsed = BuildSettingsUpdate.safeParse(req.body);
    if (!parsed.success) {
      bad(res, parsed.error.issues);
      return;
    }
    const before = await loadBuildSettings(db);
    const next = parsed.data;
    const updatedById = req.actor?.id ?? null;
    await db.setting.upsert({
      where: { key: BUILD_SETTING_KEY },
      create: { key: BUILD_SETTING_KEY, value: next, updatedById },
      update: { value: next, updatedById },
    });
    await req.audit({
      action: 'settings.builds.updated',
      entityType: 'setting',
      entityId: BUILD_SETTING_KEY,
      before,
      after: next,
    });
    res.json(next);
  });
}
