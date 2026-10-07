import { PipeNode } from './PipeNode';
import { stagesSummary, type Stage } from './stages';

/**
 * The six stages as a compact row of small nodes for an app row (SHP-T-13.7, SHP-REQ-156). One
 * element with role="img" carries the whole lane's meaning — "Pipeline: Push done, CI running, …" —
 * so a screen reader hears one sentence rather than six unlabelled icons; the nodes inside are
 * decoration. Six 16 px nodes and their connectors are narrower than a 375 px screen.
 */
export function PipeMini({ stages }: { stages: readonly Stage[] }) {
  return (
    <span className="shp-pipe-mini" role="img" aria-label={stagesSummary(stages)}>
      {stages.map((s) => (
        <span key={s.key} className="shp-pipe-mini__stage" data-stage={s.key} data-state={s.state}>
          <PipeNode state={s.state} size="sm" />
        </span>
      ))}
    </span>
  );
}
