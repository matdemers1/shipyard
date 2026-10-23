import { Alert, Spinner } from '@d3cloud/ui';
import type { StackUpdateStatus } from '@shipyard/schema';
import {
  progressHeadline,
  requesterLine,
  resultHeadline,
  shortDigest,
  stepsDone,
  useSecondsSince,
  versionWords,
  type StackPhase,
} from '../../lib/stacks';
import { WAITING_FOR_DEPLOYER } from '../../lib/words';

/**
 * A stack update's progress and then its result, inline in the stack's sheet (SHP-T-16.6,
 * SHP-ADR-010, SHP-REQ-199, SHP-REQ-200): "Waiting for a deployer to approve" while it is held; a
 * banner with the step in words — and the soak's countdown — while it runs; then one line saying
 * what runs now, or the refusal's message and fix exactly as the server sent them.
 */

function Banner({ headline, detail }: { headline: string; detail: string }) {
  return (
    <div className="shp-action-banner shp-stack-banner" role="status">
      <Spinner size="sm" />
      <span className="shp-action-banner__head">{headline}</span>
      {detail === '' ? null : <span className="shp-action-banner__detail">{detail}</span>}
    </div>
  );
}

function Images({ status }: { status: StackUpdateStatus }) {
  if (status.images.length === 0) return null;
  return (
    <ul className="shp-stack-images" aria-label="Running now">
      {status.images.map((image) => (
        <li key={image.service}>
          {image.service}: {versionWords(image.tag, image.digest)}{' '}
          <code title={image.digest}>{shortDigest(image.digest)}</code>
        </li>
      ))}
    </ul>
  );
}

export interface StackProgressProps {
  phase: StackPhase;
  /** The tag being updated to, for the result line; null for a rollback or when unknown. */
  to: string | null;
  /** The stack's soak, for the countdown. */
  soakSeconds: number | null;
  hasBackup: boolean;
}

export function StackProgress({ phase, to, soakSeconds, hasBackup }: StackProgressProps) {
  const soakStart = phase.kind === 'following' ? phase.soakStartedAt : null;
  const soaked = useSecondsSince(soakStart);

  switch (phase.kind) {
    case 'idle':
      return null;
    case 'starting':
      return <Banner headline={phase.request.kind === 'rollback' ? 'Rolling back' : 'Updating'} detail="Asking Shipyard" />;
    case 'following': {
      const { status } = phase;
      if (status.state === 'awaiting_approval') {
        return (
          <Alert tone="info" title={WAITING_FOR_DEPLOYER} dynamic>
            Requested by {status.requesterLabel}. It runs once a deployer approves it in Needs you.
          </Alert>
        );
      }
      const soak = soakStart === null || soakSeconds === null ? null : { elapsed: soaked, of: soakSeconds };
      const done = stepsDone(status.step, hasBackup);
      const detail = [...done.map((w, i) => (i === 0 ? `${w.charAt(0).toUpperCase()}${w.slice(1)}` : w)), `requested by ${requesterLine(status)}`].join(' · ');
      return <Banner headline={progressHeadline(status, soak)} detail={detail} />;
    }
    case 'refused':
      return (
        <Alert tone="danger" title={phase.error.message} dynamic>
          {phase.error.fix}
        </Alert>
      );
    case 'done': {
      const { status } = phase;
      const headline = resultHeadline(status, status.kind === 'rollback' ? null : to);
      if (status.state === 'succeeded') {
        return (
          <Alert tone="success" title={headline} dynamic>
            <Images status={status} />
          </Alert>
        );
      }
      const tone = status.state === 'rolled_back' ? 'warning' : status.state === 'cancelled' ? 'info' : 'danger';
      return (
        <Alert tone={tone} title={headline} dynamic>
          {status.refusal === null ? null : (
            <>
              <p className="shp-action-fix">{status.refusal.message}</p>
              <p className="shp-action-fix">{status.refusal.fix}</p>
            </>
          )}
        </Alert>
      );
    }
  }
}
