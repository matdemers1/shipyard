import { EmptyState, Page, PageHeader, Skeleton, Stack } from '@d3cloud/ui';
import { useCallback, useMemo, useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ageWords, chipFromParams, paramsForChip, useHost, type HostChip } from '../lib/host';
import { useStacks } from '../lib/stacks';
import { ContainerSheet } from './host/ContainerSheet';
import { StackSheet } from './host/StackSheet';
import { AgentStatus, HostView } from './host/HostView';

/**
 * Host (SHP-T-14.7, SHP-REQ-178, SHP-ADR-009): the fourth destination — everything Docker runs on
 * the host, as the agent last reported it: containers grouped by compose project with their tier,
 * volumes, images and disk, at 390 px and on a desktop. The snapshot's age is always on screen and
 * turns into a warning after two report intervals.
 *
 * The inventory is read-only (SHP-REQ-181): nothing changes a volume or an image. A container's
 * row opens its sheet (SHP-T-15.7) — logs, and the lifecycle actions its tier and the reader's role
 * allow (SHP-ADR-010, SHP-ADR-011). The filter (`?tier=` or `?state=`) and the open sheet
 * (`?container=<id>`) live in the address, so a view can be linked and Back closes the sheet.
 *
 * An adopted stack updated by digest (SHP-T-16.6, SHP-ADR-010) opens its sheet the same way:
 * `?stack=<name>` for its history (SHP-REQ-200), `&update=1` for the update sheet (SHP-REQ-194).
 */

const FOOTNOTE =
  'Read-only. Deployed is a D3 app Shipyard deploys; Operated is a third-party stack adopted with a manifest; Observed is everything else Docker runs.';

export function Host() {
  const [params, setParams] = useSearchParams();
  const chip = useMemo(() => chipFromParams(params), [params]);
  const data = useHost();
  const onChip = (next: HostChip) => {
    setParams(paramsForChip(next, params), { replace: true });
  };

  const navigate = useNavigate();
  const location = useLocation();
  const containerId = params.get('container');
  const stackName = params.get('stack');
  const stackMode = params.get('update') === '1' ? 'update' : 'history';
  const stackData = useStacks();
  const stackHref = useCallback(
    (name: string, update: boolean) => {
      const next = new URLSearchParams(params);
      next.delete('container');
      next.set('stack', name);
      if (update) next.set('update', '1');
      else next.delete('update');
      return { pathname: '/host', search: `?${next.toString()}` };
    },
    [params],
  );
  const hrefFor = useCallback(
    (id: string) => {
      const next = new URLSearchParams(params);
      next.set('container', id);
      return { pathname: '/host', search: `?${next.toString()}` };
    },
    [params],
  );
  const closeSheet = () => {
    // Opened from a row: Back is what closes it, so the history has no dangling sheet entry.
    if ((location.state as { sheet?: boolean } | null)?.sheet === true) {
      void navigate(-1);
      return;
    }
    const next = new URLSearchParams(params);
    next.delete('container');
    next.delete('stack');
    next.delete('update');
    setParams(next, { replace: true });
  };
  // Recreate gives a container a new ID: the sheet follows it by name once the next report lands.
  const lastName = useRef<string | null>(null);
  const sheetContainer = useMemo(() => {
    if (containerId === null) return null;
    const all = data.hosts.flatMap((h) => h.inventory.containers);
    const found = all.find((c) => c.id === containerId) ?? all.find((c) => lastName.current !== null && c.name === lastName.current) ?? null;
    return found;
  }, [containerId, data.hosts]);
  lastName.current = sheetContainer?.name ?? (containerId === null ? null : lastName.current);

  const first = data.hosts[0];
  const description =
    first === undefined
      ? 'Everything Docker runs on this host, read-only.'
      : `Everything Docker runs on this host, read-only. Reported ${ageWords(first.reportedAt, data.now)} ago.`;
  const single = data.hosts.length === 1 && first !== undefined;

  return (
    <Page width="wide">
      <Stack gap="24">
        <PageHeader
          title="Host"
          description={description}
          {...(single ? { actions: <span className="shp-host-agent"><AgentStatus snapshot={first} now={data.now} /></span> } : {})}
        />

        {data.status === 'loading' ? (
          <div aria-busy="true">
            <span role="status" className="shp-visually-hidden">
              Loading the host
            </span>
            <Skeleton variant="text" lines={8} />
          </div>
        ) : data.status === 'error' && data.error !== null ? (
          <EmptyState kind={data.error.status === 403 ? 'no-access' : 'error'} heading={data.error.message} headingLevel={2}>
            {data.error.fix}
          </EmptyState>
        ) : data.hosts.length === 0 ? (
          <EmptyState kind="empty" heading="No host inventory yet" headingLevel={2}>
            The agent reports everything Docker runs once it is on version f574b79 or later.
          </EmptyState>
        ) : single ? (
          <HostView
            snapshot={first}
            chip={chip}
            onChip={onChip}
            now={data.now}
            headingLevel={2}
            hrefFor={hrefFor}
            stacks={stackData.byName}
            stackHref={stackHref}
          />
        ) : (
          data.hosts.map((snapshot) => (
            <section key={snapshot.agent.id} aria-labelledby={`host-${snapshot.agent.id}`}>
              <Stack gap="16">
                <h2 id={`host-${snapshot.agent.id}`} className="shp-host-agent-heading">
                  Agent {snapshot.agent.fingerprint}
                </h2>
                <AgentStatus snapshot={snapshot} now={data.now} />
                <HostView
                  snapshot={snapshot}
                  chip={chip}
                  onChip={onChip}
                  now={data.now}
                  headingLevel={3}
                  hrefFor={hrefFor}
                  stacks={stackData.byName}
                  stackHref={stackHref}
                />
              </Stack>
            </section>
          ))
        )}

        <p className="shp-host-foot">{FOOTNOTE}</p>
      </Stack>
      {containerId !== null && data.status === 'ready' ? <ContainerSheet container={sheetContainer} open onClose={closeSheet} /> : null}
      {stackName !== null && containerId === null && data.status === 'ready' && stackData.loaded ? (
        <StackSheet
          key={`${stackName}:${stackMode}`}
          name={stackName}
          stack={stackData.byName.get(stackName) ?? null}
          mode={stackMode}
          containers={data.hosts.flatMap((h) => h.inventory.containers)}
          hrefFor={(mode) => stackHref(stackName, mode === 'update')}
          onClose={closeSheet}
          onChanged={stackData.refresh}
        />
      ) : null}
    </Page>
  );
}
