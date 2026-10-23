import { Badge, Button, FormActions, Modal, Skeleton } from '@d3cloud/ui';
import type { HostInventory } from '@shipyard/schema';
import { useMemo, useState } from 'react';
import type { Role } from '../../lib/api';
import { VOLUMES_SHOWN } from '../../lib/host';
import {
  archiveTime,
  bytes,
  isMaintenanceBusy,
  maintenance,
  rowActions,
  sortVolumeRows,
  useArchives,
  useMaintenanceJob,
  volumeRows,
  type VolumeArchive,
  type VolumeOwnerRef,
  type VolumeRow,
} from '../../lib/maintenance';
import {
  BACK_UP_FOOT,
  SHEET_WORDS,
  VOLUME_WORDS,
  anonymousVolumeWords,
  archivesCaptionWords,
  archivesCountWords,
  archivesOfWords,
  backUpTitle,
  backUpVolumeWords,
  claimedVolumeWords,
  restoreArchiveLabel,
  showAllVolumesWords,
  showFirstVolumesWords,
  showingVolumesWords,
  volumeActionLabel,
} from '../../lib/words';
import { MaintenanceProgress, RefusalAlert, VolumeBadge } from './VolumeParts';

/**
 * The Host destination's volumes (SHP-REQ-178; SHP-T-17.6, SHP-ADR-012): orphans first, then the
 * volumes a Deployed app or an Operated stack owns, then Observed ones — the largest first in each,
 * six shown with a way to see the rest. Each says who mounts it and which compose project made it.
 *
 * What a row offers depends on whose it is and who is reading (SHP-REQ-201..203): Back up (deployer
 * and up) and Restore… (admin) on an owned volume, Delete… (admin) on an orphan nothing claims, and
 * nothing at all on an Observed one. "Archives · N" opens the volume's archives, newest first —
 * deep-linkable as `?volume=<name>` — each with its time, size, whether it was quiesced, and
 * Restore… for an admin. A backup's progress and result show on its own row. Every word comes from
 * lib/words.ts.
 */

export interface VolumesProps {
  inventory: Pick<HostInventory, 'containers' | 'volumes'>;
  /**
   * The unretired apps and adopted stacks with their compose projects (SHP-ADR-012): what owns a
   * volume. Null while they are not yet known, when no row offers anything.
   */
  owners: readonly VolumeOwnerRef[] | null;
  role: Role | undefined;
  /** The volume whose archives are open (`?volume=`). */
  openVolume?: string | null;
  onToggleArchives?: (volume: string | null) => void;
  onRestore?: (volume: string, archiveId: string) => void;
  onDelete?: (volume: string) => void;
  /** Bumped after a restore or delete: every row reads its archives again. */
  reloads?: number;
  now?: Date;
}

/** Docker's anonymous volumes are 64 hex characters: shortened, and said to be anonymous. */
function displayName(name: string): string {
  return /^[0-9a-f]{64}$/.test(name) ? anonymousVolumeWords(name) : name;
}

function ArchiveList({
  volume,
  archives,
  canRestore,
  onRestore,
  now,
}: {
  volume: string;
  archives: readonly VolumeArchive[];
  canRestore: boolean;
  onRestore: (archiveId: string) => void;
  now: Date;
}) {
  return (
    <div className="shp-vol-archives" id={`archives-${volume}`}>
      <p className="shp-vol-archives__head">
        <strong>{VOLUME_WORDS.archives}</strong> <span className="shp-host-muted">{archivesCaptionWords(archives.length)}</span>
      </p>
      {archives.length === 0 ? (
        <p className="shp-vol-archives__empty">{VOLUME_WORDS.noArchives}</p>
      ) : (
        <ul className="shp-vol-archives__list" aria-label={archivesOfWords(archives.length, volume)}>
          {archives.map((a) => {
            const time = archiveTime(a.createdAt, now);
            return (
              <li key={a.archiveId} className="shp-vol-archive">
                <time className="shp-vol-archive__time" dateTime={a.createdAt} title={new Date(a.createdAt).toLocaleString()}>
                  {time}
                </time>
                <span className="shp-vol-archive__size">{bytes(a.sizeBytes)}</span>
                <span className="shp-vol-archive__how">
                  {a.quiesced ? (
                    <Badge size="sm" tone="neutral">
                      {VOLUME_WORDS.quiesced}
                    </Badge>
                  ) : (
                    <span className="shp-host-muted">{VOLUME_WORDS.liveCopy}</span>
                  )}
                </span>
                {canRestore ? (
                  <span className="shp-vol-archive__act">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={restoreArchiveLabel(time, volume)}
                      onClick={() => {
                        onRestore(a.archiveId);
                      }}
                    >
                      {VOLUME_WORDS.restore}
                    </Button>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** "Back up forgejo_data?": a backup also removes the oldest archive beyond what is kept, so it asks once. */
function BackUpConfirm({ volume, open, onCancel, onConfirm }: { volume: string; open: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      size="sm"
      title={backUpTitle(volume)}
      description={backUpVolumeWords(volume)}
      closeLabel={SHEET_WORDS.close}
      footer={
        <FormActions leading={<span className="shp-csheet__note">{BACK_UP_FOOT}</span>}>
          <Button type="button" variant="secondary" onClick={onCancel}>
            {SHEET_WORDS.cancel}
          </Button>
          <Button type="button" variant="primary" onClick={onConfirm}>
            {VOLUME_WORDS.backUp}
          </Button>
        </FormActions>
      }
    />
  );
}

function VolumeItem({
  row,
  role,
  open,
  onToggle,
  onRestore,
  onDelete,
  reloads,
  now,
}: {
  row: VolumeRow;
  role: Role | undefined;
  open: boolean;
  onToggle: () => void;
  onRestore: (archiveId: string) => void;
  onDelete: () => void;
  reloads: number;
  now: Date;
}) {
  const { volume } = row;
  const hasArchives = row.kind === 'owned' || row.kind === 'claimed';
  const [ownReloads, setOwnReloads] = useState(0);
  const { archives, error } = useArchives(volume.name, hasArchives, reloads + ownReloads);
  const count = archives?.length ?? null;
  const may = rowActions(row, role, count);
  const [confirming, setConfirming] = useState(false);
  const { phase, run } = useMaintenanceJob((status) => {
    if (status.state === 'succeeded') setOwnReloads((n) => n + 1);
  });
  const busy = isMaintenanceBusy(phase);
  const newest = archives?.[0];
  const showToggle = hasArchives && (row.kind === 'owned' || (count ?? 0) > 0);

  return (
    <li className="shp-hv" data-kind={row.kind}>
      <span className="shp-hv__name" title={volume.name}>
        {displayName(volume.name)}
      </span>
      <span className="shp-hv__size">{bytes(volume.sizeBytes)}</span>
      <span className="shp-hv__mounts">{volume.mountedBy.length === 0 ? VOLUME_WORDS.noMounts : volume.mountedBy.join(', ')}</span>
      <span className="shp-hv__project">{volume.composeProject ?? '—'}</span>
      <span className="shp-hv__badge">
        <VolumeBadge tier={row.tier} />
      </span>
      <span className="shp-hv__acts">
        {row.kind === 'observed' ? <span className="shp-host-muted">{VOLUME_WORDS.observed}</span> : null}
        {row.kind === 'claimed' && row.owner !== null ? <span className="shp-host-muted">{claimedVolumeWords(row.owner.name)}</span> : null}
        {may.backUp ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={volumeActionLabel('backUp', volume.name)}
            disabled={busy}
            onClick={() => {
              setConfirming(true);
            }}
          >
            {VOLUME_WORDS.backUp}
          </Button>
        ) : null}
        {showToggle ? (
          <Button type="button" size="sm" variant="ghost" pressed={open} aria-expanded={open} aria-controls={`archives-${volume.name}`} aria-label={archivesOfWords(count, volume.name)} onClick={onToggle}>
            {archivesCountWords(count)}
          </Button>
        ) : null}
        {may.restore && newest !== undefined ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={volumeActionLabel('restore', volume.name)}
            disabled={busy}
            onClick={() => {
              onRestore(newest.archiveId);
            }}
          >
            {VOLUME_WORDS.restore}
          </Button>
        ) : null}
        {may.remove ? (
          <Button type="button" size="sm" variant="danger-ghost" aria-label={volumeActionLabel('remove', volume.name)} onClick={onDelete}>
            {VOLUME_WORDS.remove}
          </Button>
        ) : null}
      </span>
      {phase.kind === 'idle' ? null : (
        <div className="shp-hv__wide">
          <MaintenanceProgress phase={phase} />
        </div>
      )}
      {open && showToggle ? (
        <div className="shp-hv__wide">
          {error !== null ? <RefusalAlert error={error} /> : null}
          {archives === null ? (
            error === null ? (
              <div aria-busy="true">
                <span role="status" className="shp-visually-hidden">
                  {VOLUME_WORDS.loadingArchives}
                </span>
                <Skeleton variant="text" lines={2} />
              </div>
            ) : null
          ) : (
            <ArchiveList volume={volume.name} archives={archives} canRestore={rowActions(row, role, archives.length).restore} onRestore={onRestore} now={now} />
          )}
        </div>
      ) : null}
      <BackUpConfirm
        volume={volume.name}
        open={confirming}
        onCancel={() => {
          setConfirming(false);
        }}
        onConfirm={() => {
          setConfirming(false);
          run(() => maintenance.backup(volume.name));
        }}
      />
    </li>
  );
}

export function Volumes({ inventory, owners, role, openVolume = null, onToggleArchives, onRestore, onDelete, reloads = 0, now }: VolumesProps) {
  const rows = useMemo(() => sortVolumeRows(volumeRows(inventory, owners ?? [])), [inventory, owners]);
  // Until the owners are known, a row's kind is a guess: offer nothing on it.
  const reader = owners === null ? undefined : role;
  const [all, setAll] = useState(false);
  // A linked volume past the first six opens the whole list, so the row it names is on screen.
  const linkedPast = openVolume !== null && rows.findIndex((r) => r.volume.name === openVolume) >= VOLUMES_SHOWN;
  const showAll = all || linkedPast;
  const shown = showAll ? rows : rows.slice(0, VOLUMES_SHOWN);
  const clock = useMemo(() => now ?? new Date(), [now, inventory]);
  if (rows.length === 0) return <p className="shp-host-muted">{VOLUME_WORDS.none}</p>;
  return (
    <div className="shp-hostcard">
      <ul className="shp-hv-list" aria-label={VOLUME_WORDS.heading}>
        {shown.map((row) => (
          <VolumeItem
            key={row.volume.name}
            row={row}
            role={reader}
            open={openVolume === row.volume.name}
            onToggle={() => {
              onToggleArchives?.(openVolume === row.volume.name ? null : row.volume.name);
            }}
            onRestore={(archiveId) => {
              onRestore?.(row.volume.name, archiveId);
            }}
            onDelete={() => {
              onDelete?.(row.volume.name);
            }}
            reloads={reloads}
            now={clock}
          />
        ))}
      </ul>
      <div className="shp-hostcard__foot">
        <span className="shp-host-muted">{showingVolumesWords(shown.length, rows.length)}</span>
        {rows.length > VOLUMES_SHOWN ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-expanded={showAll}
            onClick={() => {
              setAll(!showAll);
            }}
          >
            {showAll ? showFirstVolumesWords(VOLUMES_SHOWN) : showAllVolumesWords(rows.length)}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
