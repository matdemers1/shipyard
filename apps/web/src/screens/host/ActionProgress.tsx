import { Alert, Spinner } from '@d3cloud/ui';
import { useEffect, useState } from 'react';
import { progressWords, resultWords, type ActionPhase } from '../../lib/actions';
import { LIFECYCLE_ACTIVE_WORDS } from '../../lib/words';

/**
 * An action's progress and then its result, inline where it was asked for (SHP-T-15.7,
 * SHP-REQ-184): a banner with the state in words and what it waits on while it runs, then one line
 * — what happened and how long it took, or the refusal's message and fix verbatim, with compose's
 * own (redacted) output behind a disclosure.
 */

function useSecondsSince(start: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (start === null) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [start]);
  return start === null ? 0 : Math.max(0, Math.floor((now - start) / 1000));
}

function Banner({ headline, detail }: { headline: string; detail: string }) {
  return (
    <div className="shp-action-banner" role="status">
      <Spinner size="sm" />
      <span className="shp-action-banner__head">{headline}</span>
      <span className="shp-action-banner__detail">{detail}</span>
    </div>
  );
}

function Output({ output }: { output: string | null }) {
  if (output === null || output.trim() === '') return null;
  return (
    <details className="shp-disclosure">
      <summary>Compose output</summary>
      <pre className="shp-action-output">{output}</pre>
    </details>
  );
}

export function ActionProgress({ phase }: { phase: ActionPhase }) {
  const start =
    phase.kind === 'starting' ? phase.at : phase.kind === 'running' ? Date.parse(phase.status.startedAt ?? phase.status.createdAt) : null;
  const elapsed = useSecondsSince(start);

  switch (phase.kind) {
    case 'idle':
      return null;
    case 'starting':
      return <Banner headline={LIFECYCLE_ACTIVE_WORDS[phase.request.verb]} detail="Asking Shipyard" />;
    case 'running': {
      const words = progressWords(phase.status, elapsed);
      return <Banner headline={words.headline} detail={words.detail} />;
    }
    case 'refused':
      return (
        <Alert tone="danger" title={phase.error.message} dynamic>
          {phase.error.fix}
        </Alert>
      );
    case 'done': {
      const { status } = phase;
      if (status.state === 'succeeded') {
        return (
          <Alert tone="success" title={resultWords(status)} dynamic>
            <Output output={status.output} />
          </Alert>
        );
      }
      if (status.refusal !== null) {
        return (
          <Alert tone="danger" title={status.refusal.message} dynamic>
            <p className="shp-action-fix">{status.refusal.fix}</p>
            <Output output={status.output} />
          </Alert>
        );
      }
      return (
        <Alert tone={status.state === 'cancelled' ? 'info' : 'danger'} title={resultWords(status)} dynamic>
          <Output output={status.output} />
        </Alert>
      );
    }
  }
}
