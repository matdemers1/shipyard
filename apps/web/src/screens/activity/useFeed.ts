import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefusalError, unreachableRefusal } from '../../lib/api';
import { builds, type BuildSummary } from '../../lib/builds';
import { schedules, type ScheduleList } from '../../lib/schedules';
import { fetchTimeline, type TimelineItem } from '../../lib/timeline';
import {
  buildMatches,
  byTimeDesc,
  groupRollouts,
  scheduleAt,
  scheduleMatches,
  sourcesFor,
  timelineFilters,
  type ActivityFilters,
  type FeedEntry,
} from './model';

/**
 * Activity's data (SHP-T-13.13): the three stored sources — the deploy timeline, builds, schedules —
 * read through the endpoints that already exist and merged into one feed. The timeline and builds
 * page by cursor; schedules come whole (upcoming plus the fifty most recent past). A feed built
 * from pages must not show a row newer than a source's oldest loaded one when that source has more
 * to give, or "Load more" would insert rows above ones already read: so the feed is cut at the
 * newest of those oldest times.
 */

const PAGE_SIZE = 25;

function problemOf(error: unknown): RefusalError {
  return error instanceof RefusalError ? error : unreachableRefusal();
}

interface Paged<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Feed {
  loading: boolean;
  error: RefusalError | null;
  entries: FeedEntry[];
  /** True while there is more to load, here or hidden below the cut. */
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  /** Every schedule, for the Upcoming card; null until the first answer, or when it could not be read. */
  scheduleList: ScheduleList | null;
  scheduleError: RefusalError | null;
  reloadSchedules: () => void;
  /** Whether any build exists, for the Builds chip. */
  anyBuilds: boolean;
}

export function useFeed(filters: ActivityFilters): Feed {
  const sources = sourcesFor(filters);
  const filterKey = JSON.stringify(filters);

  const [timeline, setTimeline] = useState<Paged<TimelineItem>>({ items: [], nextCursor: null });
  const [buildPage, setBuildPage] = useState<Paged<BuildSummary>>({ items: [], nextCursor: null });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<RefusalError | null>(null);
  const [anyBuilds, setAnyBuilds] = useState(false);

  const [scheduleList, setScheduleList] = useState<ScheduleList | null>(null);
  const [scheduleError, setScheduleError] = useState<RefusalError | null>(null);
  const [scheduleReloads, setScheduleReloads] = useState(0);

  // Schedules do not depend on the filters: one read, narrowed in memory, re-read after a cancel.
  useEffect(() => {
    const controller = new AbortController();
    schedules
      .list(controller.signal)
      .then((list) => {
        setScheduleList(list);
        setScheduleError(null);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setScheduleError(problemOf(e));
      });
    return () => {
      controller.abort();
    };
  }, [scheduleReloads]);

  const reloadSchedules = useCallback(() => {
    setScheduleReloads((n) => n + 1);
  }, []);

  // Whether to offer the Builds chip: any build at all, whatever the filters.
  useEffect(() => {
    let live = true;
    builds
      .list({ limit: 1 })
      .then((page) => {
        if (live) setAnyBuilds(page.items.length > 0);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const wantDeploys = sources.deploys;
    const wantBuilds = sources.builds;
    setLoading(true);
    setError(null);
    const fromTimeline = wantDeploys ? fetchTimeline({ ...timelineFilters(filters), limit: PAGE_SIZE }) : Promise.resolve({ items: [], nextCursor: null });
    // Builds are the point of kind=build, so a failure there is an error; beside deploys it is just absent.
    const fromBuilds = wantBuilds
      ? builds.list({ ...(filters.app !== undefined ? { app: filters.app } : {}), limit: PAGE_SIZE, signal: controller.signal }).catch((e: unknown) => {
          if (filters.kind === 'build') throw e;
          return { items: [], nextCursor: null };
        })
      : Promise.resolve({ items: [], nextCursor: null });
    Promise.all([fromTimeline, fromBuilds])
      .then(([t, b]) => {
        if (controller.signal.aborted) return;
        setTimeline(t);
        setBuildPage(b);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(problemOf(e));
        setLoading(false);
      });
    return () => {
      controller.abort();
    };
    // `filters` is read through `filterKey`, so a new object with the same content does not refetch.
  }, [filterKey]);

  const loadMore = useCallback(() => {
    if (loadingMore) return;
    const wantTimeline = timeline.nextCursor !== null;
    const wantBuilds = buildPage.nextCursor !== null;
    if (!wantTimeline && !wantBuilds) return;
    setLoadingMore(true);
    const t =
      timeline.nextCursor !== null
        ? fetchTimeline({ ...timelineFilters(filters), cursor: timeline.nextCursor, limit: PAGE_SIZE })
        : Promise.resolve(null);
    const b =
      buildPage.nextCursor !== null
        ? builds.list({ ...(filters.app !== undefined ? { app: filters.app } : {}), limit: PAGE_SIZE, cursor: buildPage.nextCursor })
        : Promise.resolve(null);
    Promise.all([t, b])
      .then(([tp, bp]) => {
        if (tp !== null) setTimeline((prev) => ({ items: [...prev.items, ...tp.items], nextCursor: tp.nextCursor }));
        if (bp !== null) setBuildPage((prev) => ({ items: [...prev.items, ...bp.items], nextCursor: bp.nextCursor }));
      })
      .catch(() => undefined)
      .finally(() => {
        setLoadingMore(false);
      });
  }, [loadingMore, timeline.nextCursor, buildPage.nextCursor, filterKey]);

  const { entries, hasMore } = useMemo(() => {
    const dedupe = new Set<string>();
    const scheduleEntries: FeedEntry[] = [];
    if (scheduleList !== null) {
      for (const e of scheduleList.upcoming) dedupe.add(e.deployId);
      for (const e of scheduleList.past) {
        // A fired schedule is shown as its own row when schedule rows are in this view; otherwise its deploy is the row.
        if (e.status === 'cancelled' || e.state === 'cancelled' || sources.scheduleRows) dedupe.add(e.deployId);
        if (sources.scheduleRows && scheduleMatches(e, filters)) {
          scheduleEntries.push({ type: 'schedule', key: `schedule:${e.id}`, at: scheduleAt(e), entry: e });
        }
      }
    }
    const rows: FeedEntry[] = [
      ...timeline.items
        .filter((item) => !dedupe.has(item.deployId))
        .map((item): FeedEntry => ({ type: 'deploy', key: `deploy:${item.deployId}`, at: item.createdAt, item })),
      ...buildPage.items.filter((b) => buildMatches(b, filters)).map((build): FeedEntry => ({ type: 'build', key: `build:${build.buildId}`, at: build.createdAt, build })),
      ...scheduleEntries,
    ].sort(byTimeDesc);

    // The cut: the newest of the oldest loaded times among sources that still have more pages.
    const cuts: number[] = [];
    const oldest = (times: string[]): number => Math.min(...times.map((t) => Date.parse(t)));
    if (timeline.nextCursor !== null && timeline.items.length > 0) cuts.push(oldest(timeline.items.map((i) => i.createdAt)));
    if (buildPage.nextCursor !== null && buildPage.items.length > 0) cuts.push(oldest(buildPage.items.map((b) => b.createdAt)));
    const cut = cuts.length === 0 ? -Infinity : Math.max(...cuts);
    const visible = rows.filter((r) => Date.parse(r.at) >= cut);
    return {
      entries: groupRollouts(visible),
      hasMore: timeline.nextCursor !== null || buildPage.nextCursor !== null,
    };
  }, [timeline, buildPage, scheduleList, filterKey]);

  return { loading, error, entries, hasMore, loadingMore, loadMore, scheduleList, scheduleError, reloadSchedules, anyBuilds };
}
