import { Alert, Badge, FormField, Input, Spinner } from '@d3cloud/ui';
import type { ContainerTier } from '@shipyard/schema';
import { CircleCheck } from 'lucide-react';
import type { RefusalError } from '../../lib/api';
import { isDeployedTier } from '../../lib/host';
import {
  bytes,
  confirmMatches,
  progressHeadline,
  pruneGroups,
  safetyArchiveLine,
  type MaintenancePhase,
  type MaintenanceStatus,
} from '../../lib/maintenance';
import {
  AUTHENTICATOR_CODE,
  NAME_DOES_NOT_MATCH,
  NAME_MATCHES,
  TIER_WORDS,
  VOLUME_WORDS,
  backedUpDetailWords,
  backedUpWords,
  deletedWords,
  didNotWords,
  freedDetailWords,
  freedWords,
  requestedByWords,
  restoredWords,
  typeToConfirmWords,
} from '../../lib/words';

/**
 * The pieces the volume and prune screens share (SHP-T-17.6, SHP-ADR-012): the tier badge, the
 * progress banner with the step in words, the result — or the refusal's message and fix exactly as
 * the server sent them — the typed-name field with its match line, and the step-up code field.
 * Every word comes from lib/words.ts.
 */

/** Deployed, Operated or Observed; an orphan's badge is Orphaned. */
export function VolumeBadge({ tier }: { tier: ContainerTier | null }) {
  if (tier === null) {
    return (
      <Badge size="sm" tone="warning">
        {VOLUME_WORDS.orphaned}
      </Badge>
    );
  }
  return (
    <Badge size="sm" tone={isDeployedTier(tier) ? 'attention' : 'neutral'}>
      {TIER_WORDS[tier]}
    </Badge>
  );
}

function Banner({ headline, detail }: { headline: string; detail: string }) {
  return (
    <div className="shp-action-banner shp-vol-banner" role="status">
      <Spinner size="sm" />
      <span className="shp-action-banner__head">{headline}</span>
      {detail === '' ? null : <span className="shp-action-banner__detail">{detail}</span>}
    </div>
  );
}

/** A refusal, verbatim: its message as the title and its fix under it. */
export function RefusalAlert({ error, title }: { error: Pick<RefusalError, 'message' | 'fix'>; title?: string }) {
  return (
    <Alert tone="danger" title={title ?? error.message} dynamic className="shp-vol-outcome">
      {title === undefined ? (
        <p className="shp-action-fix">{error.fix}</p>
      ) : (
        <>
          <p className="shp-action-fix">{error.message}</p>
          <p className="shp-action-fix">{error.fix}</p>
        </>
      )}
    </Alert>
  );
}

/** A finished job: what it did, or what did not happen and why, verbatim (SHP-ADR-012). */
export function MaintenanceOutcome({ status, dynamic = true }: { status: MaintenanceStatus; dynamic?: boolean }) {
  if (status.state === 'succeeded') {
    switch (status.kind) {
      case 'volume-backup': {
        const archive = status.archive;
        return (
          <Alert tone="success" title={backedUpWords(status.volume ?? '', archive === null ? null : bytes(archive.sizeBytes))} dynamic={dynamic} className="shp-vol-outcome">
            {archive === null ? null : <p className="shp-action-fix">{backedUpDetailWords(archive.quiesced, status.removedArchives.length)}</p>}
          </Alert>
        );
      }
      case 'volume-restore': {
        const safety = safetyArchiveLine(status.output);
        return (
          <Alert tone="success" title={restoredWords(status.volume ?? '')} dynamic={dynamic} className="shp-vol-outcome">
            {safety === null ? null : <p className="shp-action-fix">{safety}</p>}
          </Alert>
        );
      }
      case 'volume-delete':
        return (
          <Alert tone="success" title={deletedWords(status.volume ?? '')} dynamic={dynamic} className="shp-vol-outcome">
            {null}
          </Alert>
        );
      case 'prune': {
        const prune = status.prune;
        const groups = pruneGroups(prune?.items ?? []);
        const count = (id: string) => groups.find((g) => g.id === id)?.items.length ?? 0;
        return (
          <Alert tone="success" title={freedWords(bytes(prune?.reclaimedBytes ?? prune?.reclaimableBytes ?? 0))} dynamic={dynamic} className="shp-vol-outcome shp-vol-freed">
            <p className="shp-action-fix">{freedDetailWords(count('dangling'), count('unused'), count('cache'))}</p>
          </Alert>
        );
      }
    }
  }
  const refusal = status.refusal;
  return (
    <Alert
      tone={status.state === 'cancelled' ? 'info' : 'danger'}
      title={didNotWords(status.kind, status.volume, refusal?.code ?? null)}
      dynamic={dynamic}
      className="shp-vol-outcome"
    >
      {refusal === null ? null : (
        <>
          <p className="shp-action-fix">{refusal.message}</p>
          <p className="shp-action-fix">{refusal.fix}</p>
        </>
      )}
    </Alert>
  );
}

/**
 * Where a job is: asking, then a banner with its step ("Archiving · forgejo_data") while it runs,
 * then its outcome. `hideRefusal` leaves a refusal to the caller (a step-up one belongs by its field).
 */
export function MaintenanceProgress({ phase, hideRefusal = false }: { phase: MaintenancePhase; hideRefusal?: boolean }) {
  switch (phase.kind) {
    case 'idle':
      return null;
    case 'starting':
      return <Banner headline={VOLUME_WORDS.asking} detail="" />;
    case 'following':
      return <Banner headline={progressHeadline(phase.status)} detail={requestedByWords(phase.status.requester.label)} />;
    case 'refused':
      return hideRefusal ? null : <RefusalAlert error={phase.error} />;
    case 'done':
      return <MaintenanceOutcome status={phase.status} />;
  }
}

/** "Type forgejo_data to confirm", and whether what is typed is the name exactly. */
export function TypedName({ volume, value, onChange, disabled }: { volume: string; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const matches = confirmMatches(value, volume);
  const help =
    value === '' ? undefined : matches ? (
      <span className="shp-vol-match" data-match="">
        <CircleCheck aria-hidden="true" size={14} />
        {NAME_MATCHES}
      </span>
    ) : (
      <span className="shp-vol-match">{NAME_DOES_NOT_MATCH}</span>
    );
  return (
    <FormField label={typeToConfirmWords(volume)} width="md" {...(help === undefined ? {} : { help })}>
      <Input
        value={value}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
    </FormField>
  );
}

/** The authenticator code a step-up takes (SHP-ADR-012 amendment): six digits, a fresh one. */
export function StepUpField({ value, onChange, help, error, disabled }: { value: string; onChange: (value: string) => void; help: string; error: RefusalError | null; disabled?: boolean }) {
  return (
    <FormField
      label={AUTHENTICATOR_CODE}
      width="sm"
      help={help}
      {...(error === null
        ? {}
        : {
            error: (
              <>
                {error.message} {error.fix}
              </>
            ),
          })}
    >
      <Input
        value={value}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={7}
        invalid={error !== null}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
    </FormField>
  );
}
