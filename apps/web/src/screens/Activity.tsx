import { Button, EmptyState, Input, Page, PageHeader, Select, Skeleton, Stack } from '@d3cloud/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ScheduleSheet } from '../components/ScheduleSheet';
import { useCan } from '../lib/auth';
import { OUTCOME_OPTIONS, dayKey, dayLabel, fetchAppNames } from '../lib/timeline';
import { FeedRow } from './activity/FeedRow';
import { Upcoming } from './activity/Upcoming';
import { KIND_CHIPS, filtersFromParams, hasFilters, sourcesFor, type FeedEntry } from './activity/model';
import { useFeed } from './activity/useFeed';

/**
 * Activity (SHP-T-13.13, SHP-REQ-164, SHP-ADR-006): the one place for what has happened and what is
 * coming — deploys, rollbacks, refusals, schedules and Shipyard builds as a single feed grouped by
 * day, upcoming schedules pinned on top, a "Deploy all ready" rollout as one expandable row. Every
 * filter lives in the address (`?app=&kind=&outcome=&requester=`), so a view can be linked, and the
 * old Timeline, Builds and Schedules routes land here with their kind already set.
 *
 * Pushes and CI runs are not listed: Shipyard stores neither, they are live GitHub data on the app
 * and commit pages (the footnote says so).
 */

type Day = { key: string; label: string; entries: FeedEntry[] };

/** Rows in the order given, folded into one section per local calendar day. */
function byDay(entries: readonly FeedEntry[], now: Date): Day[] {
  const days: Day[] = [];
  for (const entry of entries) {
    const key = dayKey(entry.at);
    const last = days[days.length - 1];
    if (last !== undefined && last.key === key) last.entries.push(entry);
    else days.push({ key, label: dayLabel(entry.at, now), entries: [entry] });
  }
  return days;
}

export function Activity() {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => filtersFromParams(params), [params]);
  const filtered = hasFilters(filters);
  const sources = sourcesFor(filters);
  const can = useCan();
  const feed = useFeed(filters);

  const [appNames, setAppNames] = useState<string[]>([]);
  const [requesterInput, setRequesterInput] = useState(filters.requester ?? '');

  useEffect(() => {
    fetchAppNames()
      .then(setAppNames)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    setRequesterInput(filters.requester ?? '');
  }, [filters.requester]);

  function setFilter(key: 'app' | 'requester' | 'outcome' | 'kind', value: string) {
    const next = new URLSearchParams(params);
    if (value === '') next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  }

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const { hasMore, loadMore } = feed;
  useEffect(() => {
    if (!hasMore || typeof IntersectionObserver === 'undefined') return;
    const el = sentinelRef.current;
    if (el === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting === true) loadMore();
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [hasMore, loadMore]);

  const now = useMemo(() => new Date(), [feed.entries]);
  const days = useMemo(() => byDay(feed.entries, now), [feed.entries, now]);

  const appOptions = useMemo(() => {
    const names = filters.app !== undefined && !appNames.includes(filters.app) ? [...appNames, filters.app] : appNames;
    return [{ value: '', label: 'All apps' }, ...names.map((name) => ({ value: name, label: name }))];
  }, [filters.app, appNames]);

  const upcoming = (feed.scheduleList?.upcoming ?? []).filter((e) => filters.app === undefined || e.app === filters.app);
  const chips = KIND_CHIPS.filter((c) => c.value !== 'build' || feed.anyBuilds || filters.kind === 'build');

  return (
    <Page width="wide">
      <Stack gap="24">
        <PageHeader
          title="Activity"
          description="Every deploy, rollback, refusal, schedule and Shipyard build, newest first."
          {...(can ? { actions: <ScheduleSheet apps={appNames} onScheduled={feed.reloadSchedules} /> } : {})}
        />

        <div className="shp-feed-filters" role="group" aria-label="Filter activity">
          <div className="shp-feed-filters__chips">
            {chips.map((chip) => {
              const on = filters.kind === chip.value;
              return (
                <Button
                  key={chip.value}
                  type="button"
                  size="sm"
                  variant="secondary"
                  pressed={on}
                  onClick={() => {
                    setFilter('kind', on ? '' : chip.value);
                  }}
                >
                  {chip.label}
                </Button>
              );
            })}
          </div>
          <div className="shp-feed-filters__fields">
            <Select aria-label="App" size="sm" value={filters.app ?? ''} onValueChange={(v) => { setFilter('app', v); }} placeholder="All apps" options={appOptions} />
            <Input
              aria-label="Requester"
              size="sm"
              placeholder="Anyone"
              value={requesterInput}
              onChange={(e) => {
                setRequesterInput(e.target.value);
              }}
              onBlur={() => {
                setFilter('requester', requesterInput.trim());
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setFilter('requester', requesterInput.trim());
              }}
            />
            <Select
              aria-label="Outcome"
              size="sm"
              value={filters.outcome ?? ''}
              onValueChange={(v) => {
                setFilter('outcome', v);
              }}
              placeholder="All outcomes"
              options={[{ value: '', label: 'All outcomes' }, ...OUTCOME_OPTIONS]}
            />
          </div>
        </div>

        {sources.showUpcoming && upcoming.length > 0 ? <Upcoming entries={upcoming} can={can} now={now} onChanged={feed.reloadSchedules} /> : null}
        {filters.kind === 'schedule' && feed.scheduleError !== null ? (
          <EmptyState kind="error" heading={feed.scheduleError.message} headingLevel={2}>
            {feed.scheduleError.fix}
          </EmptyState>
        ) : null}

        {feed.loading ? (
          <div aria-busy="true">
            <span role="status" className="shp-visually-hidden">
              Loading activity
            </span>
            <Skeleton variant="text" lines={6} />
          </div>
        ) : feed.error !== null ? (
          <EmptyState kind={feed.error.status === 403 ? 'no-access' : 'error'} heading={feed.error.message} headingLevel={2}>
            {feed.error.fix}
          </EmptyState>
        ) : days.length === 0 ? (
          filtered ? (
            <EmptyState
              kind="no-results"
              heading="Nothing matches"
              headingLevel={2}
              action={
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setParams(new URLSearchParams(), { replace: true });
                  }}
                >
                  Clear filters
                </Button>
              }
            >
              Try a different app, kind, requester or outcome.
            </EmptyState>
          ) : (
            <EmptyState kind="empty" heading="No activity yet" headingLevel={2}>
              A deploy, rollback, refusal, schedule or build will show up here.
            </EmptyState>
          )
        ) : (
          <div className="shp-feed">
            {days.map((day) => (
              <section key={day.key} aria-labelledby={`day-${day.key}`}>
                <h2 id={`day-${day.key}`} className="shp-feed-day">
                  {day.label}
                </h2>
                <ul className="shp-feed-list" aria-label={day.label}>
                  {day.entries.map((entry) => (
                    <FeedRow key={entry.key} entry={entry} now={now} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        {hasMore && !feed.loading ? (
          <div ref={sentinelRef}>
            <Button type="button" variant="secondary" onClick={loadMore} loading={feed.loadingMore}>
              Load more
            </Button>
          </div>
        ) : null}

        <p className="shp-feed-foot">
          Pushes and CI runs are not listed here — Shipyard doesn&apos;t store them. They are live GitHub data, shown on each app and commit page.
        </p>
      </Stack>
    </Page>
  );
}
