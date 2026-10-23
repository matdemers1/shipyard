import { Alert, Button, Modal } from '@d3cloud/ui';
import { useState } from 'react';
import type { Role } from '../../lib/api';
import { bytes, canRestoreOrDelete, confirmMatches, isMaintenanceBusy, maintenance, useMaintenanceJob, useStepUp, type VolumeRow } from '../../lib/maintenance';
import {
  DELETE_FACTS,
  DELETE_FOOT,
  DELETE_STEP_UP_HELP,
  DELETE_WARNING_TITLE,
  SHEET_WORDS,
  VOLUME_NOT_FOUND,
  deleteInUseWords,
  deleteIntroWords,
  deleteTitle,
  deleteVerb,
  deleteWarningWords,
  volumeNotFoundWords,
} from '../../lib/words';
import { MaintenanceProgress, StepUpField, TypedName, VolumeBadge } from './VolumeParts';

/**
 * Delete an orphaned volume (SHP-T-17.6, SHP-REQ-203, SHP-ADR-012 and its 2026-10-23 amendment),
 * opened from an orphan's Delete… — `?volume=<name>&delete=1` on Host, so Back closes it. What the
 * volume is (size, when it was made, its driver, the compose project its label names, that nothing
 * mounts it), that it cannot be undone, then the name typed exactly and a fresh step-up. An admin's,
 * in the console only. If a container mounts it by the time the agent looks, the server refuses
 * `volume_in_use` and nothing is deleted — shown verbatim.
 */

export interface DeleteSheetProps {
  volume: string;
  row: VolumeRow | null;
  role: Role | undefined;
  onClose: () => void;
  onChanged: () => void;
}

function createdWords(iso: string | null): string {
  if (iso === null) return DELETE_FACTS.unknown;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? DELETE_FACTS.unknown : at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function DeleteSheet({ volume, row, role, onClose, onChanged }: DeleteSheetProps) {
  const stepUp = useStepUp();
  const { phase, run } = useMaintenanceJob(() => {
    onChanged();
  });
  const [typed, setTyped] = useState('');

  const onOpenChange = (open: boolean) => {
    if (!open) onClose();
  };

  if (row === null) {
    return (
      <Modal open onOpenChange={onOpenChange} title={VOLUME_NOT_FOUND} closeLabel={SHEET_WORDS.close} size="md">
        <p>{volumeNotFoundWords(volume)}</p>
      </Modal>
    );
  }

  const v = row.volume;
  const admin = canRestoreOrDelete(role);
  const busy = isMaintenanceBusy(phase);
  const finished = phase.kind === 'done';
  const locked = busy || finished;
  const canSubmit = admin && row.kind === 'orphan' && confirmMatches(typed, volume) && stepUp.ready && !locked;
  const stepUpShown = phase.kind === 'refused' && phase.error === stepUp.error;
  const facts: [string, string][] = [
    [DELETE_FACTS.size, bytes(v.sizeBytes)],
    [DELETE_FACTS.created, createdWords(v.createdAt)],
    [DELETE_FACTS.driver, v.driver],
    [DELETE_FACTS.project, v.composeProject ?? DELETE_FACTS.unknown],
    [DELETE_FACTS.mountedBy, v.mountedBy.length === 0 ? DELETE_FACTS.noContainer : v.mountedBy.join(', ')],
  ];

  return (
    <Modal
      open
      onOpenChange={onOpenChange}
      className="shp-csheet shp-ssheet shp-vsheet"
      size="lg"
      destructive
      closeLabel={SHEET_WORDS.close}
      title={deleteTitle(volume)}
      description={
        <span className="shp-csheet__facts">
          <span className="shp-csheet__line">
            <VolumeBadge tier={row.tier} />
          </span>
          <span className="shp-csheet__line">{deleteIntroWords(v.composeProject)}</span>
        </span>
      }
      footer={
        <>
          <span className="shp-csheet__note">{DELETE_FOOT}</span>
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
                run(stepUp.guard(() => maintenance.remove(volume, { confirmVolume: typed })));
              }}
            >
              {deleteVerb(volume)}
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
        <dl className="shp-vol-facts" aria-label={DELETE_FACTS.label}>
          {facts.map(([term, value]) => (
            <div key={term} className="shp-vol-facts__row">
              <dt>{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <Alert tone="danger" title={DELETE_WARNING_TITLE}>
          {deleteWarningWords(bytes(v.sizeBytes))}
        </Alert>
        {admin ? (
          <>
            <TypedName volume={volume} value={typed} onChange={setTyped} disabled={locked} />
            <StepUpField value={stepUp.code} onChange={stepUp.setCode} help={DELETE_STEP_UP_HELP} error={stepUp.error} disabled={locked} />
          </>
        ) : null}
        <p className="shp-csheet__muted">{deleteInUseWords(volume)}</p>
        <MaintenanceProgress phase={phase} hideRefusal={stepUpShown} />
      </div>
    </Modal>
  );
}
