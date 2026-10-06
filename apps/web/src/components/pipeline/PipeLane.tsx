import { Link } from '@d3cloud/ui';
import { PipeNode, StageGlyph } from './PipeNode';
import { STATE_LABEL, type Stage } from './stages';

/**
 * The full lane for the app and commit pages (SHP-T-13.7, SHP-REQ-156): each stage's node, its
 * label, its value and a quieter note. CI's value links to the commit's GitHub Actions run in a new
 * tab (SHP-REQ-167). Six columns from 768 px up; a vertical list under it, where the lane would be
 * too narrow to read.
 */
export function PipeLane({ stages, label = 'Pipeline' }: { stages: readonly Stage[]; label?: string }) {
  return (
    <ol className="shp-pipe-lane" aria-label={label}>
      {stages.map((s) => (
        <li key={s.key} className="shp-pipe-lane__stage" data-stage={s.key} data-state={s.state}>
          <PipeNode state={s.state} />
          <div className="shp-pipe-lane__text">
            <span className="shp-pipe-lane__label">
              <StageGlyph stage={s.key} />
              {s.label}
              <span className="shp-pipe-sr">, {STATE_LABEL[s.state].toLowerCase()}</span>
            </span>
            <span className="shp-pipe-lane__detail">{s.detail}</span>
            {s.href !== undefined ? (
              <Link href={s.href} target="_blank" rel="noreferrer" className="shp-pipe-lane__link">
                {s.linkLabel ?? 'Open'} ↗
              </Link>
            ) : null}
            {s.note !== undefined ? <span className="shp-pipe-lane__note">{s.note}</span> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
