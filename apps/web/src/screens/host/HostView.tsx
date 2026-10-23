import { Badge, Button, Card, EmptyState, Section, Stack, Stat, StatGroup, StatusDot } from '@d3cloud/ui';
import type { HostSnapshot } from '@shipyard/schema';
import { useMemo } from 'react';
import {
  HOST_CHIPS,
  ageWords,
  bytesWords,
  chipCounts,
  groupContainers,
  hostTotals,
  isStale,
  matchesChip,
  type HostChip,
} from '../../lib/host';
import { ContainerGroups, type ContainerHref } from './ContainerGroups';
import { Volumes } from './Volumes';

/**
 * One agent's host snapshot (SHP-T-14.7, SHP-REQ-178): the summary tiles, the filter chips, the
 * containers by compose project, the volumes and the images. The inventory itself is read-only
 * (SHP-REQ-181); a container's lifecycle actions live in its sheet and a group's "Restart stack"
 * (SHP-T-15.7, SHP-ADR-010), never on a volume or an image.
 */

export interface HostViewProps {
  snapshot: HostSnapshot;
  chip: HostChip;
  onChip: (chip: HostChip) => void;
  now: number;
  /** 2 for the only host, 3 when each host has its own heading. */
  headingLevel: 2 | 3;
  /** Where a container's row opens its sheet. */
  hrefFor: ContainerHref;
}

function plural(n: number, one: string, other: string): string {
  return `${String(n)} ${n === 1 ? one : other}`;
}

/** The agent's line: reporting, or stale and maybe down, in the library's warning tone. */
export function AgentStatus({ snapshot, now }: { snapshot: HostSnapshot; now: number }) {
  const stale = isStale(snapshot.reportedAt, now);
  return (
    <StatusDot tone={stale ? 'warning' : 'neutral'} size="sm" title={snapshot.agent.fingerprint}>
      {stale ? 'Agent not reporting' : 'Agent reporting'}
    </StatusDot>
  );
}

export function HostView({ snapshot, chip, onChip, now, headingLevel, hrefFor }: HostViewProps) {
  const inventory = snapshot.inventory;
  const totals = useMemo(() => hostTotals(inventory), [inventory]);
  const counts = useMemo(() => chipCounts(inventory.containers), [inventory]);
  const groups = useMemo(() => groupContainers(inventory.containers.filter((c) => matchesChip(c, chip))), [inventory, chip]);
  const images = totals.images;
  const disk = inventory.disk.dataRoot;
  const stale = isStale(snapshot.reportedAt, now);

  return (
    <Stack gap="24">
      {stale ? (
        <p className="shp-host-stale">
          <StatusDot tone="warning">Last reported {ageWords(snapshot.reportedAt, now)} ago — the agent may be down.</StatusDot>
        </p>
      ) : null}

      <StatGroup role="group" aria-label="Host summary" className="shp-host-tiles">
        <Stat
          label="Containers"
          value={String(totals.containers.total)}
          footnote={`${String(totals.containers.running)} running · ${String(totals.containers.notRunning)} not running`}
        />
        <Stat
          label="Volumes"
          value={String(totals.volumes.count)}
          footnote={
            <span className="shp-host-tile__foot">
              <span>{bytesWords(totals.volumes.bytes)} in all</span>
              {totals.volumes.orphaned > 0 ? (
                <Badge size="sm" tone="warning">
                  {totals.volumes.orphaned} orphaned
                </Badge>
              ) : null}
            </span>
          }
        />
        <Stat
          label="Images"
          value={String(images.count)}
          footnote={`${bytesWords(images.bytes)} · ${String(images.unusedCount)} not used by any container`}
        />
        <Stat
          label="Disk"
          value={bytesWords(disk.freeBytes)}
          unit="free"
          footnote={
            <>
              of {bytesWords(disk.totalBytes)} on {disk.path}
              <span className="shp-host-wide"> · build cache {bytesWords(inventory.builderCache.bytes)}</span>
            </>
          }
        />
      </StatGroup>

      <div className="shp-host-chips" role="group" aria-label="Filter containers">
        {HOST_CHIPS.map((c) => (
          <Button
            key={c.id}
            type="button"
            size="sm"
            variant="secondary"
            pressed={chip === c.id}
            onClick={() => {
              onChip(c.id);
            }}
          >
            {c.label} <span className="shp-host-chips__count">{counts[c.id]}</span>
          </Button>
        ))}
      </div>

      <Section surface="plain" headingLevel={headingLevel} title="Containers">
        {groups.length === 0 ? (
          <EmptyState kind="no-results" size="inline" heading="No container matches" headingLevel={headingLevel === 2 ? 3 : 4}>
            {chip === 'all' ? 'Docker runs no containers on this host.' : 'Choose All to see every container.'}
          </EmptyState>
        ) : (
          <ContainerGroups groups={groups} samples={snapshot.samples} hrefFor={hrefFor} />
        )}
      </Section>

      <Section
        surface="plain"
        headingLevel={headingLevel}
        title={
          <span className="shp-host-heading">
            Volumes
            {totals.volumes.orphaned > 0 ? (
              <Badge size="sm" tone="warning">
                {totals.volumes.orphaned} orphaned
              </Badge>
            ) : null}
          </span>
        }
      >
        <Volumes volumes={inventory.volumes} />
      </Section>

      <Section surface="plain" headingLevel={headingLevel} title="Images">
        <Card padding="md">
          <p className="shp-host-images">
            {plural(images.count, 'image', 'images')} · {bytesWords(images.bytes)} · {String(images.unusedCount)} not used by any container (
            {bytesWords(images.unusedBytes)}) · {String(images.dangling)} untagged
          </p>
          {images.largest.length > 0 ? (
            <p className="shp-host-muted">
              Largest:{' '}
              {images.largest.map((r) => `${r.repository} (${bytesWords(r.bytes)} × ${plural(r.versions, 'version', 'versions')})`).join(' · ')}
            </p>
          ) : null}
        </Card>
      </Section>
    </Stack>
  );
}
