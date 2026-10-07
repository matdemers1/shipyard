import { Alert } from '@d3cloud/ui';
import type { SystemStatus } from '@shipyard/schema';
import { useCallback, useEffect, useState } from 'react';
import { RefusalError, request, unreachableRefusal } from '../../lib/api';
import { system as systemApi } from '../../lib/system';

/**
 * What the Settings sections share (SHP-T-13.6): the refusal shape, the host status the sub-nav's
 * warning dot and the Host section both read, and whether any app builds with Shipyard — which
 * decides whether the Builds section is collapsed and marked unused.
 */

export function asRefusal(error: unknown): RefusalError {
  return error instanceof RefusalError ? error : unreachableRefusal();
}

/** Every refusal says what happened and how to fix it. */
export function RefusalAlert({ refusal }: { refusal: RefusalError | null }) {
  if (refusal === null) return null;
  return (
    <Alert tone="danger" title={refusal.message} dynamic>
      {refusal.fix}
    </Alert>
  );
}

export interface SystemStatusState {
  status: SystemStatus | null;
  refusal: RefusalError | null;
  reload: () => void;
}

/**
 * `GET /api/system`, read once by the Settings frame and refreshed every half minute so a heartbeat
 * or an outbox count is never a stale claim. A viewer cannot read it, so it is not asked for.
 */
export function useSystemStatus(enabled: boolean): SystemStatusState {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [refusal, setRefusal] = useState<RefusalError | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await systemApi.status());
      setRefusal(null);
    } catch (error) {
      setRefusal(asRefusal(error));
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 30_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [enabled, load]);

  return {
    status,
    refusal,
    reload: () => {
      void load();
    },
  };
}

/** Which apps take their images from Shipyard's own builds, out of how many. */
export interface BuildUse {
  total: number;
  shipyard: string[];
}

interface AppDetailManifest {
  manifest?: unknown;
}

/** `build.source: shipyard` in an app's manifest; anything unreadable is GitHub, the server's own default. */
export function buildsWithShipyard(manifest: unknown): boolean {
  if (typeof manifest !== 'object' || manifest === null) return false;
  const build = (manifest as { build?: unknown }).build;
  if (typeof build !== 'object' || build === null) return false;
  return (build as { source?: unknown }).source === 'shipyard';
}

export interface BuildUseState {
  use: BuildUse | null;
  loading: boolean;
}

/**
 * Reads each app's manifest to learn whether any builds with Shipyard. `use` is null when it cannot
 * be read — the Builds section then stays open rather than claiming it is unused. Admin-only, like
 * the two places that show it, so nobody else pays for the reads.
 */
export function useBuildUse(enabled: boolean): BuildUseState {
  const [state, setState] = useState<BuildUseState>({ use: null, loading: enabled });

  useEffect(() => {
    if (!enabled) return;
    const run = { live: true };
    void (async () => {
      try {
        const { apps } = await request<{ apps: { name: string }[] }>('/api/apps');
        const details = await Promise.all(
          apps.map((app) => request<AppDetailManifest>(`/api/apps/${encodeURIComponent(app.name)}`)),
        );
        const shipyard = apps.filter((_, i) => buildsWithShipyard(details[i]?.manifest)).map((app) => app.name);
        if (run.live) setState({ use: { total: apps.length, shipyard }, loading: false });
      } catch {
        if (run.live) setState({ use: null, loading: false });
      }
    })();
    return () => {
      run.live = false;
    };
  }, [enabled]);

  return state;
}

/** "No app uses Shipyard builds — all 6 build on GitHub Actions", the line both Builds places show. */
export function unusedBuildsLine(use: BuildUse): string {
  if (use.total === 0) return 'No app uses Shipyard builds yet — there are no apps.';
  if (use.total === 1) return 'No app uses Shipyard builds — the one app builds on GitHub Actions.';
  return `No app uses Shipyard builds — all ${String(use.total)} build on GitHub Actions.`;
}
