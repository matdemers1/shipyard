import { EmptyState, Page, PageHeader, Skeleton, Stack } from '@d3cloud/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useMe } from '../lib/auth';
import { ageWords, chipFromParams, paramsForChip, useHost, type HostChip } from '../lib/host';
import { useOwnerApps, volumeOwners, volumeRows, type MaintenanceStatus } from '../lib/maintenance';
import { isTerminalStackUpdate, useStacks, type StackPhase, type StackView } from '../lib/stacks';
import { HOST_FOOTNOTE } from '../lib/words';
import { ContainerSheet } from './host/ContainerSheet';
import { DeleteSheet } from './host/DeleteSheet';
import { PruneSheet } from './host/PruneSheet';
import { RestoreSheet } from './host/RestoreSheet';
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
 *
 * Volumes and disk (SHP-T-17.6, SHP-ADR-012): `?volume=<name>` opens a volume's archives,
 * `&restore=<archiveId>` the restore sheet (SHP-REQ-202), `&delete=1` an orphan's delete sheet
 * (SHP-REQ-203), and `?prune=1` the prune sheet from the Disk card (SHP-REQ-205); Back closes each.
 */

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
  const me = useMe();
  const role = me?.role;
  const volumeName = params.get('volume');
  const restoreId = params.get('restore');
  const deleting = params.get('delete') === '1';
  const pruning = params.get('prune') === '1';
  const [volumeReloads, setVolumeReloads] = useState(0);
  const [pruneResult, setPruneResult] = useState<MaintenanceStatus | null>(null);
  const bumpVolumes = useCallback(() => {
    setVolumeReloads((n) => n + 1);
  }, []);
  const stackName = params.get('stack');
  const stackMode = params.get('update') === '1' ? 'update' : 'history';
  const stackData = useStacks();
  // The open sheet's own poll, so its group header shows the step it is on — and that it ended —
  // without waiting for the next read of the stacks (SHP-T-16.6).
  const [sheetPhase, setSheetPhase] = useState<{ stack: string; phase: StackPhase } | null>(null);
  const onPhase = useCallback((stack: string, phase: StackPhase) => {
    setSheetPhase({ stack, phase });
  }, []);
  // Only while that sheet is open: closed (or Back), the stacks' own reads speak for it again.
  const openPhase = sheetPhase !== null && sheetPhase.stack === stackName && containerId === null ? sheetPhase : null;
  const stacksShown = useMemo(() => {
    if (openPhase === null) return stackData.byName;
    const { stack: name, phase } = openPhase;
    const stack = stackData.byName.get(name);
    if (stack === undefined) return stackData.byName;
    let next: StackView = stack;
    if (phase.kind === 'following') next = { ...stack, activeUpdate: phase.status };
    else if (phase.kind === 'done' && isTerminalStackUpdate(phase.status.state)) {
      next = { ...stack, activeUpdate: stack.activeUpdate?.id === phase.status.id ? null : stack.activeUpdate, lastUpdate: phase.status };
    }
    if (next === stack) return stackData.byName;
    return new Map([...stackData.byName, [name, next]]);
  }, [stackData.byName, openPhase]);
  const busyStacks = useMemo(
    () => new Set(openPhase !== null && (openPhase.phase.kind === 'starting' || openPhase.phase.kind === 'following') ? [openPhase.stack] : []),
    [openPhase],
  );
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
    next.delete('restore');
    next.delete('delete');
    next.delete('prune');
    setParams(next, { replace: true });
  };
  /** Opens a sheet as its own history entry, so Back closes it. */
  const openSheet = useCallback(
    (change: (next: URLSearchParams) => void) => {
      const next = new URLSearchParams(params);
      next.delete('container');
      next.delete('stack');
      next.delete('update');
      change(next);
      void navigate({ pathname: '/host', search: `?${next.toString()}` }, { state: { sheet: true } });
    },
    [params, navigate],
  );
  const onToggleArchives = useCallback(
    (volume: string | null) => {
      const next = new URLSearchParams(params);
      if (volume === null) next.delete('volume');
      else next.set('volume', volume);
      next.delete('restore');
      next.delete('delete');
      setParams(next, { replace: true });
    },
    [params, setParams],
  );
  const onRestore = useCallback(
    (volume: string, archiveId: string) => {
      openSheet((next) => {
        next.set('volume', volume);
        next.set('restore', archiveId);
        next.delete('delete');
      });
    },
    [openSheet],
  );
  const onDelete = useCallback(
    (volume: string) => {
      openSheet((next) => {
        next.set('volume', volume);
        next.set('delete', '1');
        next.delete('restore');
      });
    },
    [openSheet],
  );
  const onPrune = useCallback(() => {
    openSheet((next) => {
      next.set('prune', '1');
    });
  }, [openSheet]);
  // Who owns a volume: the unretired apps and the adopted stacks, once both lists have answered.
  const ownerApps = useOwnerApps();
  const owners = useMemo(
    () => (ownerApps === null || !stackData.answered ? null : volumeOwners(ownerApps, [...stackData.byName.values()])),
    [ownerApps, stackData.answered, stackData.byName],
  );
  const volumeRow = useMemo(() => {
    if (volumeName === null || owners === null) return null;
    for (const h of data.hosts) {
      const row = volumeRows(h.inventory, owners).find((r) => r.volume.name === volumeName);
      if (row !== undefined) return row;
    }
    return null;
  }, [volumeName, data.hosts, owners]);
  // Needs you links to the Disk card: once the snapshot is on screen, bring it into view.
  const ready = data.status === 'ready';
  useEffect(() => {
    if (!ready || location.hash !== '#disk') return;
    // jsdom has no scrollIntoView; a browser always does.
    (document.getElementById('disk') as Partial<HTMLElement> | null)?.scrollIntoView?.({ block: 'center' });
  }, [ready, location.hash]);
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
            stacks={stacksShown}
            stackHref={stackHref}
            busyStacks={busyStacks}
            role={role}
            openVolume={volumeName}
            onToggleArchives={onToggleArchives}
            onRestore={onRestore}
            onDelete={onDelete}
            onPrune={onPrune}
            pruneResult={pruneResult}
            volumeReloads={volumeReloads}
            volumeOwners={owners}
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
                  stacks={stacksShown}
                  stackHref={stackHref}
                  busyStacks={busyStacks}
                  role={role}
                  openVolume={volumeName}
                  onToggleArchives={onToggleArchives}
                  onRestore={onRestore}
                  onDelete={onDelete}
                  onPrune={onPrune}
                  pruneResult={pruneResult}
                  volumeReloads={volumeReloads}
                  volumeOwners={owners}
                />
              </Stack>
            </section>
          ))
        )}

        <p className="shp-host-foot">{HOST_FOOTNOTE}</p>
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
          onPhase={onPhase}
        />
      ) : null}
      {volumeName !== null && restoreId !== null && !deleting && data.status === 'ready' && owners !== null ? (
        <RestoreSheet key={`${volumeName}:${restoreId}`} volume={volumeName} row={volumeRow} archiveId={restoreId} role={role} onClose={closeSheet} onChanged={bumpVolumes} />
      ) : null}
      {volumeName !== null && deleting && data.status === 'ready' && owners !== null ? (
        <DeleteSheet key={volumeName} volume={volumeName} row={volumeRow} role={role} onClose={closeSheet} onChanged={bumpVolumes} />
      ) : null}
      {pruning && data.status === 'ready' ? <PruneSheet role={role} onClose={closeSheet} onPruned={setPruneResult} /> : null}
    </Page>
  );
}
