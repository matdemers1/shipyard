import { Alert, Badge, Button, Modal, Skeleton } from '@d3cloud/ui';
import { useMemo, useState } from 'react';
import type { Role } from '../../lib/api';
import {
  archiveTime,
  bytes,
  canRestoreOrDelete,
  confirmMatches,
  isMaintenanceBusy,
  maintenance,
  restoreChain,
  useArchives,
  useMaintenanceJob,
  useStepUp,
  type VolumeRow,
} from '../../lib/maintenance';
import {
  ARCHIVE_TITLE,
  NEWEST_FIRST,
  NO_ARCHIVE_TO_RESTORE,
  RESTORE_FOOT,
  RESTORE_STEP_UP_HELP,
  RESTORE_WARNING_TITLE,
  SHEET_WORDS,
  VOLUME_NOT_FOUND,
  VOLUME_WORDS,
  WHAT_HAPPENS_TITLE,
  restoreIntroWords,
  restoreTitle,
  restoreVerb,
  restoreWarningWords,
  volumeNotFoundWords,
} from '../../lib/words';
import { MaintenanceProgress, RefusalAlert, StepUpField, TypedName, VolumeBadge } from './VolumeParts';

/**
 * Restore a volume from an archive (SHP-T-17.6, SHP-REQ-202, SHP-ADR-012 and its 2026-10-23
 * amendment), opened from a volume's row or one of its archives — `?volume=<name>&restore=<archiveId>`
 * on Host, so it can be linked and Back closes it. On a desktop a panel on the right, on a phone a
 * bottom sheet with its footer pinned, the way the stack update sheet is.
 *
 * It says what is lost, the chain the agent runs (stop the owner, empty the volume, unpack the
 * archive, start the owner, health), and offers the volume's archives from the agent's own ledger,
 * newest first. The danger button enables only once the volume's name is typed exactly and an
 * archive is picked; it is an admin's, in the console, with a fresh step-up — never over MCP or a
 * token. A refusal is shown verbatim; a success names the safety archive the agent took first.
 */

export interface RestoreSheetProps {
  volume: string;
  /** The volume as the latest snapshot says it; null when no host reports one by that name. */
  row: VolumeRow | null;
  /** The archive the sheet opened on. */
  archiveId: string | null;
  role: Role | undefined;
  onClose: () => void;
  /** A restore ended: read the archives again. */
  onChanged: () => void;
}

export function RestoreSheet({ volume, row, archiveId, role, onClose, onChanged }: RestoreSheetProps) {
  const { archives, error } = useArchives(volume, row !== null);
  const [picked, setPicked] = useState<string | null>(archiveId);
  const [typed, setTyped] = useState('');
  const stepUp = useStepUp();
  const { phase, run } = useMaintenanceJob(() => {
    onChanged();
  });
  const now = useMemo(() => new Date(), []);

  const onOpenChange = (open: boolean) => {
    if (!open) onClose();
  };

  const closeButton = (
    <span className="shp-csheet__close">
      <Button type="button" variant="ghost" size="sm" onClick={onClose}>
        {SHEET_WORDS.close}
      </Button>
    </span>
  );

  if (row === null) {
    return (
      <Modal open onOpenChange={onOpenChange} title={VOLUME_NOT_FOUND} closeLabel={SHEET_WORDS.close} size="md">
        <p>{volumeNotFoundWords(volume)}</p>
      </Modal>
    );
  }

  const owner = row.owner;
  const selected = archives?.find((a) => a.archiveId === picked) ?? archives?.[0] ?? null;
  const admin = canRestoreOrDelete(role);
  const busy = isMaintenanceBusy(phase);
  const finished = phase.kind === 'done';
  const locked = busy || finished;
  const canSubmit = admin && row.kind === 'owned' && selected !== null && confirmMatches(typed, volume) && stepUp.ready && !locked;
  const stepUpShown = phase.kind === 'refused' && phase.error === stepUp.error;

  return (
    <Modal
      open
      onOpenChange={onOpenChange}
      className="shp-csheet shp-ssheet shp-vsheet"
      size="lg"
      destructive
      closeLabel={SHEET_WORDS.close}
      title={restoreTitle(volume)}
      description={
        <span className="shp-csheet__facts">
          <span className="shp-csheet__line">
            <VolumeBadge tier={row.tier} />
          </span>
          <span className="shp-csheet__line">{restoreIntroWords(volume, owner?.name ?? volume, row.ownerContainers)}</span>
        </span>
      }
      footer={
        <>
          <span className="shp-csheet__note">{RESTORE_FOOT}</span>
          <Button type="button" variant="secondary" onClick={onClose}>
            {finished ? SHEET_WORDS.done : SHEET_WORDS.cancel}
          </Button>
          {admin && !finished ? (
            <Button
              type="button"
              variant="danger"
              disabled={!canSubmit}
              loading={busy}
              onClick={() => {
                if (selected === null) return;
                const archive = selected.archiveId;
                run(stepUp.guard(() => maintenance.restore(volume, { archiveId: archive, confirmVolume: typed })));
              }}
            >
              {restoreVerb(volume)}
            </Button>
          ) : null}
        </>
      }
    >
      {closeButton}
      <div className="shp-csheet__body">
        <Alert tone="danger" title={RESTORE_WARNING_TITLE}>
          {restoreWarningWords(volume, bytes(row.volume.sizeBytes))}
        </Alert>

        <section className="shp-stack-section" aria-labelledby={`restore-chain-${volume}`}>
          <h3 id={`restore-chain-${volume}`} className="shp-stack-section__title">
            {WHAT_HAPPENS_TITLE}
          </h3>
          <ol className="shp-stack-chain">
            {restoreChain(volume, owner, row.ownerContainers, selected, now).map((step) => (
              <li key={step} className="shp-stack-chain__step">
                <span className="shp-stack-chain__chip">{step}</span>
              </li>
            ))}
          </ol>
        </section>

        <fieldset className="shp-vol-pick" disabled={locked}>
          <legend className="shp-vol-pick__legend">
            <span className="shp-stack-section__title">{ARCHIVE_TITLE}</span>
            <span className="shp-host-muted">{NEWEST_FIRST}</span>
          </legend>
          {error !== null ? <RefusalAlert error={error} /> : null}
          {archives === null ? (
            error === null ? (
              <div aria-busy="true">
                <span role="status" className="shp-visually-hidden">
                  {VOLUME_WORDS.loadingArchives}
                </span>
                <Skeleton variant="text" lines={3} />
              </div>
            ) : null
          ) : archives.length === 0 ? (
            <p className="shp-csheet__muted">{NO_ARCHIVE_TO_RESTORE}</p>
          ) : (
            <ul className="shp-vol-pick__list">
              {archives.map((a) => {
                const time = archiveTime(a.createdAt, now);
                return (
                  <li key={a.archiveId}>
                    <label className="shp-vol-pick__row" data-checked={selected?.archiveId === a.archiveId ? '' : undefined}>
                      <input
                        type="radio"
                        name={`archive-${volume}`}
                        value={a.archiveId}
                        checked={selected?.archiveId === a.archiveId}
                        onChange={() => {
                          setPicked(a.archiveId);
                        }}
                      />
                      <span className="shp-vol-pick__time">{time}</span>
                      <span className="shp-vol-pick__size">{bytes(a.sizeBytes)}</span>
                      <span className="shp-vol-pick__how">
                        {a.quiesced ? (
                          <Badge size="sm" tone="neutral">
                            {VOLUME_WORDS.quiesced}
                          </Badge>
                        ) : (
                          <span className="shp-host-muted">{VOLUME_WORDS.liveCopy}</span>
                        )}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>

        {admin ? (
          <>
            <TypedName volume={volume} value={typed} onChange={setTyped} disabled={locked} />
            <StepUpField value={stepUp.code} onChange={stepUp.setCode} help={RESTORE_STEP_UP_HELP} error={stepUp.error} disabled={locked} />
          </>
        ) : null}

        <MaintenanceProgress phase={phase} hideRefusal={stepUpShown} />
      </div>
    </Modal>
  );
}
