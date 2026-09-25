import { Badge, Button, DataList, DataListRow, EmptyState, FilterBar, FormField, Input, Page, PageHeader, Select, Spinner } from '@d3cloud/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { RefusalError } from '../lib/api';
import {
  KIND_OPTIONS,
  OUTCOME_OPTIONS,
  fetchAppNames,
  fetchTimeline,
  formatRelativeTime,
  outcomeLabel,
  outcomeTone,
  shortSha,
  type DeployKind,
  type TimelineFilters,
  type TimelineItem,
  type TimelineOutcome,
} from '../lib/timeline';

/** Timeline (S8, SHP-REQ-062): every deploy, rollback and refusal, filterable by app, requester and outcome. */

const PAGE_SIZE = 25;

function isOutcome(v: string): v is TimelineOutcome {
  return OUTCOME_OPTIONS.some((o) => o.value === v);
}

function isKind(v: string): v is DeployKind {
  return KIND_OPTIONS.some((o) => o.value === v);
}

function filtersFromParams(params: URLSearchParams): TimelineFilters {
  const app = params.get('app') ?? undefined;
  const requester = params.get('requester') ?? undefined;
  const outcomeRaw = params.get('outcome') ?? '';
  const kindRaw = params.get('kind') ?? '';
  return {
    ...(app !== undefined && app !== '' ? { app } : {}),
    ...(requester !== undefined && requester !== '' ? { requester } : {}),
    ...(isOutcome(outcomeRaw) ? { outcome: outcomeRaw } : {}),
    ...(isKind(kindRaw) ? { kind: kindRaw } : {}),
  };
}

export function Timeline() {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => filtersFromParams(params), [params]);
  const hasFilters = filters.app !== undefined || filters.requester !== undefined || filters.outcome !== undefined || filters.kind !== undefined;

  const [appNames, setAppNames] = useState<string[]>([]);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<RefusalError | null>(null);
  const [requesterInput, setRequesterInput] = useState(filters.requester ?? '');

  useEffect(() => {
    fetchAppNames()
      .then(setAppNames)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    setRequesterInput(filters.requester ?? '');
  }, [filters.requester]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchTimeline({ ...filters, limit: PAGE_SIZE })
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof RefusalError ? err : new RefusalError({ code: 'invalid_request', gate: 'none', message: 'Could not load the timeline.', fix: 'Try again.' }, 0));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters]);

  const loadMore = useCallback(() => {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    fetchTimeline({ ...filters, cursor: nextCursor, limit: PAGE_SIZE })
      .then((page) => {
        setItems((prev) => [...prev, ...page.items]);
        setNextCursor(page.nextCursor);
      })
      .catch(() => undefined)
      .finally(() => {
        setLoadingMore(false);
      });
  }, [filters, nextCursor, loadingMore]);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (nextCursor === null) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const el = sentinelRef.current;
    if (el === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting === true) loadMore();
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [nextCursor, loadMore]);

  function setFilter(key: 'app' | 'requester' | 'outcome' | 'kind', value: string) {
    const next = new URLSearchParams(params);
    if (value === '') next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  }

  function clearFilters() {
    setParams(new URLSearchParams(), { replace: true });
  }

  return (
    <Page width="wide">
      <PageHeader title="Timeline" description="Every deploy, rollback and refusal across every app." />

      <FilterBar aria-label="Filter the timeline">
        <FormField label="App" width="sm">
          <Select
            aria-label="App"
            value={filters.app ?? ''}
            onValueChange={(v) => {
              setFilter('app', v);
            }}
            placeholder="All apps"
            options={[{ value: '', label: 'All apps' }, ...appNames.map((name) => ({ value: name, label: name }))]}
          />
        </FormField>
        <FormField label="Requester" width="sm">
          <Input
            aria-label="Requester"
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
        </FormField>
        <FormField label="Outcome" width="sm">
          <Select
            aria-label="Outcome"
            value={filters.outcome ?? ''}
            onValueChange={(v) => {
              setFilter('outcome', v);
            }}
            placeholder="All outcomes"
            options={[{ value: '', label: 'All outcomes' }, ...OUTCOME_OPTIONS]}
          />
        </FormField>
        <FormField label="Kind" width="sm">
          <Select
            aria-label="Kind"
            value={filters.kind ?? ''}
            onValueChange={(v) => {
              setFilter('kind', v);
            }}
            placeholder="All kinds"
            options={[{ value: '', label: 'All kinds' }, ...KIND_OPTIONS]}
          />
        </FormField>
      </FilterBar>

      {loading ? (
        <Spinner label="Loading the timeline" />
      ) : error !== null ? (
        <EmptyState kind="error" heading={error.message} headingLevel={2}>
          {error.fix}
        </EmptyState>
      ) : (
        <DataList
          aria-label="Deploys"
          empty={
            hasFilters ? (
              <EmptyState
                kind="no-results"
                heading="No deploys match"
                headingLevel={2}
                action={
                  <Button type="button" variant="secondary" onClick={clearFilters}>
                    Clear filters
                  </Button>
                }
              >
                Try a different app, requester or outcome.
              </EmptyState>
            ) : (
              <EmptyState kind="empty" heading="No deploys yet" headingLevel={2}>
                A deploy, rollback or refusal will show up here.
              </EmptyState>
            )
          }
        >
          {items.map((item) => (
            <DataListRow
              key={item.deployId}
              href={`/deploys/${item.deployId}`}
              title={
                <>
                  {item.app} · {shortSha(item.sha)}
                </>
              }
              description={
                item.state === 'refused' && item.refusalCode !== null
                  ? `${item.requesterLabel} · ${item.refusalCode}`
                  : item.requesterLabel
              }
              meta={
                <>
                  <Badge tone={outcomeTone(item.state)}>{outcomeLabel(item.state)}</Badge>
                  <span>{formatRelativeTime(item.createdAt)}</span>
                </>
              }
            />
          ))}
        </DataList>
      )}

      {nextCursor !== null && !loading ? (
        <div ref={sentinelRef}>
          <Button type="button" variant="secondary" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      ) : null}
    </Page>
  );
}
