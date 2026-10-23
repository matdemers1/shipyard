import { Alert, Spinner } from '@d3cloud/ui';
import type { StackUpdateStatus } from '@shipyard/schema';
import { progressHeadline, requesterLine, resultHeadline, shortDigest, stepsDone, versionWords, type StackPhase } from '../../lib/stacks';
import { RUNNING_NOW, STACK_PROGRESS_WORDS, WAITING_FOR_DEPLOYER, heldHintWords, requestedByWords } from '../../lib/words';

/**
 * A stack update's progress and then its result, inline in the stack's sheet (SHP-T-16.6,
 * SHP-ADR-010, SHP-REQ-199, SHP-REQ-200): "Waiting for a deployer to approve" while it is held; a
 * banner with the step in words while it runs — the soak by its length, never a countdown the
 * status cannot back; then one line saying what runs now, or the refusal's message and fix exactly
 * as the server sent them. `StackOutcome` is that last part on its own, so the sheet shows a stack's
 * newest failure to whoever opens it, not only to the session that asked (SHP-REQ-200). Every word
 * comes from lib/words.ts.
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
    <ul className="shp-stack-images" aria-label={RUNNING_NOW}>
      {status.images.map((image) => (
        <li key={image.service}>
          {image.service}: {versionWords(image.tag, image.digest)} <code title={image.digest}>{shortDigest(image.digest)}</code>
        </li>
      ))}
    </ul>
  );
}

/** A finished update: what runs now, or its refusal's message and fix verbatim. `dynamic` when it just happened. */
export function StackOutcome({ status, tagFor, dynamic }: { status: StackUpdateStatus; tagFor: (digest: string) => string | null; dynamic: boolean }) {
  const headline = resultHeadline(status, tagFor);
  if (status.state === 'succeeded') {
    return (
      <Alert tone="success" title={headline} dynamic={dynamic}>
        <Images status={status} />
      </Alert>
    );
  }
  const tone = status.state === 'rolled_back' ? 'warning' : status.state === 'cancelled' ? 'info' : 'danger';
  return (
    <Alert tone={tone} title={headline} dynamic={dynamic} className="shp-stack-outcome">
      {status.refusal === null ? null : (
        <>
          <p className="shp-action-fix">{status.refusal.message}</p>
          <p className="shp-action-fix">{status.refusal.fix}</p>
        </>
      )}
    </Alert>
  );
}

export interface StackProgressProps {
  phase: StackPhase;
  /** The stack's candidate tag for a digest, for the result line. */
  tagFor: (digest: string) => string | null;
  /** The stack's soak, named while it soaks. */
  soakSeconds: number | null;
  hasBackup: boolean;
}

export function StackProgress({ phase, tagFor, soakSeconds, hasBackup }: StackProgressProps) {
  switch (phase.kind) {
    case 'idle':
      return null;
    case 'starting':
      return <Banner headline={phase.request.kind === 'rollback' ? STACK_PROGRESS_WORDS.rollingBack : STACK_PROGRESS_WORDS.updating} detail={STACK_PROGRESS_WORDS.asking} />;
    case 'following': {
      const { status } = phase;
      if (status.state === 'awaiting_approval') {
        return (
          <Alert tone="info" title={WAITING_FOR_DEPLOYER} dynamic>
            {heldHintWords(status.requesterLabel)}
          </Alert>
        );
      }
      const done = stepsDone(status.step, hasBackup).map((w, i) => (i === 0 ? `${w.charAt(0).toUpperCase()}${w.slice(1)}` : w));
      const detail = [...done, requestedByWords(requesterLine(status))].join(' · ');
      return <Banner headline={progressHeadline(status, soakSeconds)} detail={detail} />;
    }
    case 'refused':
      return (
        <Alert tone="danger" title={phase.error.message} dynamic>
          {phase.error.fix}
        </Alert>
      );
    case 'done':
      return <StackOutcome status={phase.status} tagFor={tagFor} dynamic />;
  }
}
