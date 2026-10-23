import { Badge, Button, EmptyState, Modal } from '@d3cloud/ui';
import { Lock } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { Role } from '../../lib/api';
import {
  bytes,
  canBackUpOrPrune,
  daysSince,
  isMaintenanceBusy,
  maintenance,
  pruneGroups,
  pruneItemName,
  useMaintenanceJob,
  type MaintenanceStatus,
} from '../../lib/maintenance';
import {
  PRUNE_GROUP_WORDS,
  PRUNE_INTRO,
  PRUNE_NOTHING,
  PRUNE_NOTHING_WORDS,
  PRUNE_NO_VOLUMES,
  PRUNE_RUN_AGAIN,
  PRUNE_THESE,
  PRUNE_TITLE,
  SHEET_WORDS,
  VOLUME_WORDS,
  morePruneItemsWords,
  pruneFootWords,
  pruneGroupTotalWords,
  pruneItemDetailWords,
  pruneSummaryWords,
  reclaimWords,
} from '../../lib/words';
import { MaintenanceOutcome, MaintenanceProgress } from './VolumeParts';

/**
 * Prune images and build cache from a dry run (SHP-T-17.6, SHP-REQ-205, SHP-ADR-012), opened from
 * the Disk card's Prune… — `?prune=1` on Host. Opening it runs the dry run; the sheet lists what it
 * found, grouped as dangling images, unused images and build cache older than a week, with the space
 * it gives back. "Prune these" sends that dry run's ID (`fromDryRunId`) and the agent removes only
 * what it listed and is still eligible. Volumes are never pruned. A deployer and up; recorded in
 * Activity. The result — "Freed 3.2 GB" — shows here and on the Disk card.
 */

/** Rows shown per group before the rest fold into one "N more entries" row. */
const GROUP_ROWS = 10;

export interface PruneSheetProps {
  role: Role | undefined;
  onClose: () => void;
  /** A real prune ended: the Disk card shows its result. */
  onPruned: (status: MaintenanceStatus) => void;
}

function clockOf(iso: string | null): string {
  if (iso === null) return '—';
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

function DryRunList({ status, now, onAgain, busy }: { status: MaintenanceStatus; now: number; onAgain: () => void; busy: boolean }) {
  const prune = status.prune;
  const items = prune?.items ?? [];
  const groups = pruneGroups(items);
  if (items.length === 0) {
    return (
      <EmptyState kind="empty" size="inline" heading={PRUNE_NOTHING} headingLevel={3}>
        {PRUNE_NOTHING_WORDS}
      </EmptyState>
    );
  }
  return (
    <>
      <div className="shp-prune-total">
        <span className="shp-prune-total__words">
          <strong className="shp-prune-total__bytes">{reclaimWords(bytes(prune?.reclaimableBytes ?? 0))}</strong>
          <span className="shp-host-muted">{pruneSummaryWords(items.length, clockOf(status.finishedAt))}</span>
        </span>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onAgain}>
          {PRUNE_RUN_AGAIN}
        </Button>
      </div>
      {groups.map((g) => {
        const words = PRUNE_GROUP_WORDS[g.id];
        const shown = g.items.slice(0, GROUP_ROWS);
        const rest = g.items.slice(GROUP_ROWS);
        return (
          <section key={g.id} className="shp-prune-group" aria-labelledby={`prune-${g.id}`}>
            <header className="shp-prune-group__head">
              <h3 id={`prune-${g.id}`} className="shp-prune-group__title">
                {words.title}
              </h3>
              <span className="shp-prune-group__hint">{words.hint}</span>
              <span className="shp-prune-group__total">{pruneGroupTotalWords(g.items.length, bytes(g.bytes))}</span>
            </header>
            <ul className="shp-prune-group__list" aria-label={words.title}>
              {shown.map((item) => (
                <li key={item.id} className="shp-prune-item">
                  <code className="shp-prune-item__name" title={item.ref ?? item.id}>
                    {pruneItemName(item)}
                  </code>
                  <span className="shp-prune-item__detail">{pruneItemDetailWords(item.reason, daysSince(item.createdAt, now))}</span>
                  <span className="shp-prune-item__size">{bytes(item.sizeBytes)}</span>
                </li>
              ))}
              {rest.length === 0 ? null : (
                <li className="shp-prune-item shp-prune-item--more">
                  <span className="shp-prune-item__name">{morePruneItemsWords(rest.length, bytes(rest.reduce((n, i) => n + i.sizeBytes, 0)))}</span>
                </li>
              )}
            </ul>
          </section>
        );
      })}
    </>
  );
}

export function PruneSheet({ role, onClose, onPruned }: PruneSheetProps) {
  const may = canBackUpOrPrune(role);
  const dry = useMaintenanceJob();
  const real = useMaintenanceJob(onPruned);
  const asked = useRef(false);

  const runDry = dry.run;
  const resetReal = real.reset;
  const again = () => {
    resetReal();
    runDry(() => maintenance.prune({ dryRun: true }));
  };

  // The dry run is what opening the sheet does (SHP-REQ-205); once, even when React mounts twice.
  useEffect(() => {
    if (!may || asked.current) return;
    asked.current = true;
    runDry(() => maintenance.prune({ dryRun: true }));
  }, [may, runDry]);

  const onOpenChange = (open: boolean) => {
    if (!open) onClose();
  };

  const listed = dry.phase.kind === 'done' && dry.phase.status.state === 'succeeded' ? dry.phase.status : null;
  const count = listed?.prune?.items.length ?? null;
  const realBusy = isMaintenanceBusy(real.phase);
  const realDone = real.phase.kind === 'done';
  const canPrune = may && listed !== null && (count ?? 0) > 0 && !realBusy && !realDone;

  return (
    <Modal
      open
      onOpenChange={onOpenChange}
      className="shp-csheet shp-ssheet shp-vsheet"
      size="lg"
      closeLabel={SHEET_WORDS.close}
      title={PRUNE_TITLE}
      description={
        <span className="shp-csheet__facts">
          <span className="shp-csheet__line">
            <Badge size="sm" tone="neutral">
              {VOLUME_WORDS.dryRun}
            </Badge>
          </span>
          <span className="shp-csheet__line">{PRUNE_INTRO}</span>
        </span>
      }
      footer={
        <>
          <span className="shp-csheet__note">{pruneFootWords(count)}</span>
          <Button type="button" variant="secondary" onClick={onClose}>
            {realDone ? SHEET_WORDS.done : SHEET_WORDS.cancel}
          </Button>
          {may && !realDone ? (
            <Button
              type="button"
              variant="primary"
              disabled={!canPrune}
              loading={realBusy}
              onClick={() => {
                if (listed === null) return;
                const fromDryRunId = listed.id;
                real.run(() => maintenance.prune({ dryRun: false, fromDryRunId }));
              }}
            >
              {PRUNE_THESE}
            </Button>
          ) : null}
        </>
      }
    >
      <span className="shp-csheet__close">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {SHEET_WORDS.close}
        </Button>
      </span>
      <div className="shp-csheet__body">
        <p className="shp-prune-lock">
          <Lock aria-hidden="true" size={14} />
          {PRUNE_NO_VOLUMES}
        </p>
        {dry.phase.kind === 'done' && listed === null ? <MaintenanceOutcome status={dry.phase.status} /> : null}
        {dry.phase.kind === 'done' ? null : <MaintenanceProgress phase={dry.phase} />}
        {listed === null ? null : <DryRunList status={listed} now={Date.now()} onAgain={again} busy={realBusy} />}
        <MaintenanceProgress phase={real.phase} />
      </div>
    </Modal>
  );
}
