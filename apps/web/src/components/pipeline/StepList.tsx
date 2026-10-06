import type { DeployTargetState } from '@shipyard/schema';
import { useEffect, useState } from 'react';
import type { DeployStep } from '../../lib/progress';
import { PipeNode } from './PipeNode';
import { deploySteps, STATE_LABEL } from './stages';

/** The clock a running step's timer reads; ticks each second only while something is running. */
function useNow(active: boolean, pinned: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || pinned !== undefined) return undefined;
    const id = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, [active, pinned]);
  return pinned ?? now;
}

/**
 * The deploy page's steps (SHP-T-13.7, SHP-REQ-156): every planned step — Back up, Migrate, Pull,
 * Swap, Check, Soak, and Roll back when it happens — listed up front with its state and a timer,
 * so a step not reached yet shows as waiting rather than being absent. `now` pins the clock for a
 * test; otherwise a running step's timer ticks once a second.
 */
export function StepList({
  steps,
  state,
  soakSeconds,
  now,
}: {
  steps: readonly DeployStep[];
  state: DeployTargetState;
  soakSeconds?: number;
  now?: number;
}) {
  const running = steps.some((s) => s.endedAt === null);
  const clock = useNow(running, now);
  const rows = deploySteps(steps, state, { now: clock, ...(soakSeconds === undefined ? {} : { soakSeconds }) });
  return (
    <ol className="shp-steplist" aria-label="Deploy steps">
      {rows.map((r) => (
        <li key={r.key} className="shp-steplist__row" data-step={r.key} data-state={r.state}>
          <PipeNode state={r.state} size="sm" />
          {/* The literal spaces keep the row reading "Back up Done 12s" to a screen reader and to copy. */}
          <span className="shp-steplist__label">{r.label}</span>{' '}
          <span className="shp-steplist__state">{STATE_LABEL[r.state]}</span>
          {r.detail === '' ? null : (
            <>
              {' '}
              <span className="shp-steplist__time">{r.detail}</span>
            </>
          )}
        </li>
      ))}
    </ol>
  );
}
