import { Badge, Button } from '@d3cloud/ui';
import type { HostVolume } from '@shipyard/schema';
import { useState } from 'react';
import { VOLUMES_SHOWN, bytesWords, sortVolumes } from '../../lib/host';

/**
 * The Host destination's volumes (SHP-REQ-178): orphans first, then the largest, the first six with
 * a way to see the rest. Each says who mounts it and which compose project made it. Read-only: an
 * orphan is marked, never removed from here (SHP-REQ-181).
 */
export function Volumes({ volumes }: { volumes: readonly HostVolume[] }) {
  const [all, setAll] = useState(false);
  const sorted = sortVolumes(volumes);
  const shown = all ? sorted : sorted.slice(0, VOLUMES_SHOWN);
  if (volumes.length === 0) return <p className="shp-host-muted">No named volumes.</p>;
  return (
    <div className="shp-hostcard">
      <ul className="shp-hv-list" aria-label="Volumes">
        {shown.map((v) => (
          <li key={v.name} className="shp-hv">
            <span className="shp-hv__name" title={v.name}>
              {v.name}
            </span>
            <span className="shp-hv__size">{bytesWords(v.sizeBytes)}</span>
            <span className="shp-hv__mounts">{v.mountedBy.length === 0 ? 'No container mounts it' : v.mountedBy.join(', ')}</span>
            <span className="shp-hv__project">{v.composeProject ?? '—'}</span>
            <span className="shp-hv__badge">
              {v.orphan ? (
                <Badge size="sm" tone="warning">
                  Orphaned
                </Badge>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      <div className="shp-hostcard__foot">
        <span className="shp-host-muted">
          Showing {String(shown.length)} of {String(volumes.length)} · orphans first
        </span>
        {volumes.length > VOLUMES_SHOWN ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-expanded={all}
            onClick={() => {
              setAll(!all);
            }}
          >
            {all ? `Show the first ${String(VOLUMES_SHOWN)}` : `Show all ${String(volumes.length)}`}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
