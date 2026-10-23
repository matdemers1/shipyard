import type { HostSample } from '@shipyard/schema';
import { sparkPoints } from '../../lib/host';

const WIDTH = 72;
const HEIGHT = 20;

/**
 * A container's CPU over the samples the server keeps (SHP-ADR-009): one inline SVG line in the
 * accent colour, named for a screen reader by its range. A dash with fewer than two samples.
 */
export function Sparkline({ samples }: { samples: readonly HostSample[] | undefined }) {
  const points = sparkPoints(samples, WIDTH, HEIGHT);
  if (points === null || samples === undefined) {
    return (
      <span className="shp-hc__dash">
        <span aria-hidden="true">—</span>
        <span className="shp-visually-hidden">No CPU history yet</span>
      </span>
    );
  }
  const values = samples.map((s) => s.cpuPercent);
  const label = `CPU over the last ${String(samples.length)} reports, ${Math.min(...values).toFixed(1)}% to ${Math.max(...values).toFixed(1)}%`;
  return (
    <svg className="shp-spark" role="img" aria-label={label} viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`} width={WIDTH} height={HEIGHT}>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
