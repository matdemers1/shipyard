import { Badge, Button, DataList, DataListRow, EmptyState, FilterBar, FormField, Link, Page, PageHeader, Select, Skeleton, Stack } from '@d3cloud/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { RefusalError, unreachableRefusal } from '../lib/api';
import {
  TRIGGER_LABEL,
  buildStateTone,
  builds,
  sha7,
  type BuildSummary,
} from '../lib/builds';
import { fetchAppNames, formatRelativeTime } from '../lib/timeline';
import { BUILD_STATE_WORDS } from '../lib/words';

/**
 * Builds, `/builds` (SHP-T-7.12, SHP-REQ-142): every build Shipyard ran or queued, newest first,
 * filterable by app (`?app=`). Each row names the app, the commit, the state in words, what
 * triggered it, who asked and when; it opens the build's live detail.
 */

const PAGE_SIZE = 25;

type Load = { status: 'loading' } | { status: 'error'; error: RefusalError } | { status: 'ready'; items: BuildSummary[]; nextCursor: string | null };

export function BuildRow({ build }: { build: BuildSummary }) {
  return (
    <DataListRow
      title={
        <Link asChild>
          <RouterLink to={`/builds/${build.buildId}`}>
            {build.app} · <code>{sha7(build.sha)}</code>
          </RouterLink>
        </Link>
      }
      description={`${TRIGGER_LABEL[build.trigger]} · ${build.requesterLabel}`}
      meta={
        <>
          <Badge tone={buildStateTone(build.state)}>{BUILD_STATE_WORDS[build.state]}</Badge>
          <span>{formatRelativeTime(build.createdAt)}</span>
        </>
      }
    />
  );
}

export function Builds() {
  const [params, setParams] = useSearchParams();
  const app = params.get('app') ?? '';
  const [appNames, setAppNames] = useState<string[]>([]);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    fetchAppNames()
      .then(setAppNames)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ status: 'loading' });
    builds
      .list({ app, limit: PAGE_SIZE, signal: controller.signal })
      .then((page) => {
        setLoad({ status: 'ready', items: page.items, nextCursor: page.nextCursor });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad({ status: 'error', error: error instanceof RefusalError ? error : unreachableRefusal() });
      });
    return () => {
      controller.abort();
    };
  }, [app, reloads]);

  const loadMore = useCallback(() => {
    if (load.status !== 'ready' || load.nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    builds
      .list({ app, limit: PAGE_SIZE, cursor: load.nextCursor })
      .then((page) => {
        setLoad((prev) => (prev.status === 'ready' ? { status: 'ready', items: [...prev.items, ...page.items], nextCursor: page.nextCursor } : prev));
      })
      .catch(() => undefined)
      .finally(() => {
        setLoadingMore(false);
      });
  }, [app, load, loadingMore]);

  const options = useMemo(() => {
    const names = app !== '' && !appNames.includes(app) ? [...appNames, app] : appNames;
    return [{ value: '', label: 'All apps' }, ...names.map((name) => ({ value: name, label: name }))];
  }, [app, appNames]);

  function setApp(value: string) {
    const next = new URLSearchParams(params);
    if (value === '') next.delete('app');
    else next.set('app', value);
    setParams(next, { replace: true });
  }

  return (
    <Page width="wide">
      <Stack gap="24">
        <PageHeader title="Builds" description="Images Shipyard built: fetch, test, integration, build and push." />

        <FilterBar aria-label="Filter builds">
          <FormField label="App" width="sm">
            <Select aria-label="App" value={app} onValueChange={setApp} placeholder="All apps" options={options} />
          </FormField>
        </FilterBar>

        {load.status === 'loading' ? (
          <div aria-busy="true">
            <span role="status" className="shp-visually-hidden">
              Loading builds
            </span>
            <Skeleton variant="text" lines={6} />
          </div>
        ) : load.status === 'error' ? (
          <EmptyState
            kind={load.error.status === 403 ? 'no-access' : 'error'}
            heading={load.error.message}
            headingLevel={2}
            action={
              <Button
                type="button"
                onClick={() => {
                  setReloads((n) => n + 1);
                }}
              >
                Try again
              </Button>
            }
          >
            {load.error.fix}
          </EmptyState>
        ) : (
          <DataList
            aria-label="Builds"
            empty={
              app !== '' ? (
                <EmptyState
                  kind="no-results"
                  heading={`No builds of ${app}`}
                  headingLevel={2}
                  action={
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        setApp('');
                      }}
                    >
                      Show every app
                    </Button>
                  }
                >
                  A build appears here once {app} is pushed with build.source: shipyard, or a deployer queues one.
                </EmptyState>
              ) : (
                <EmptyState kind="empty" heading="No builds yet" headingLevel={2}>
                  An app whose manifest says build.source: shipyard is built here when it is pushed.
                </EmptyState>
              )
            }
          >
            {load.items.map((build) => (
              <BuildRow key={build.buildId} build={build} />
            ))}
          </DataList>
        )}

        {load.status === 'ready' && load.nextCursor !== null ? (
          <div>
            <Button type="button" variant="secondary" onClick={loadMore} loading={loadingMore}>
              Load more
            </Button>
          </div>
        ) : null}
      </Stack>
    </Page>
  );
}
