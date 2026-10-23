import { Badge, Link, StatusDot } from '@d3cloud/ui';
import type { HostContainer, HostSnapshot } from '@shipyard/schema';
import { ChevronRight } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  containerStatus,
  cpuWords,
  defaultOpen,
  isDeployedTier,
  memoryWords,
  phoneLine,
  restartWords,
  type ContainerGroup,
} from '../../lib/host';
import { TIER_WORDS } from '../../lib/words';
import { Sparkline } from './Sparkline';

/**
 * The Host destination's containers (SHP-REQ-178): one group per compose project, Deployed first,
 * then Operated, then Observed, and the containers compose did not create last. A group opens by
 * default when something in it is not running or unhealthy; when all is well, only the first does.
 * Read-only (SHP-REQ-181): the only controls are the disclosure toggles, and a Deployed group's
 * link to its app page.
 */

export const NO_COMPOSE_NAME = 'Not in a compose project';

function containerCount(n: number): string {
  return `${String(n)} ${n === 1 ? 'container' : 'containers'}`;
}

function ContainerRow({ container, samples }: { container: HostContainer; samples: HostSnapshot['samples'] }) {
  const status = containerStatus(container);
  return (
    <li className="shp-hc">
      <span className="shp-hc__name">
        <span className="shp-hc__title">{container.name}</span>
        {container.compose === null ? null : <span className="shp-hc__service">{container.compose.service}</span>}
      </span>
      <span className="shp-hc__image" title={container.image}>
        {container.image}
      </span>
      <span className="shp-hc__status">
        <StatusDot tone={status.tone} size="sm">
          <span className="shp-hc__words">{status.words}</span>
          <span className="shp-hc__short">{status.short}</span>
        </StatusDot>
      </span>
      <span className="shp-hc__restarts" data-some={container.restartCount > 0 ? '' : undefined}>
        {restartWords(container.restartCount)}
      </span>
      <span className="shp-hc__cpu">{cpuWords(container.stats)}</span>
      <span className="shp-hc__mem">{memoryWords(container.stats)}</span>
      <span className="shp-hc__spark">
        <Sparkline samples={samples[container.name]} />
      </span>
      <span className="shp-hc__line">{phoneLine(container)}</span>
    </li>
  );
}

function Group({
  group,
  open,
  onToggle,
  samples,
}: {
  group: ContainerGroup;
  open: boolean;
  onToggle: () => void;
  samples: HostSnapshot['samples'];
}) {
  const listId = useId();
  const name = group.project ?? NO_COMPOSE_NAME;
  const linkToApp = isDeployedTier(group.tier) && group.app !== null;
  return (
    <li className="shp-hg">
      <div className="shp-hg__head">
        <button type="button" className="shp-hg__toggle" aria-expanded={open} aria-controls={listId} onClick={onToggle}>
          <ChevronRight aria-hidden="true" size={16} className="shp-hg__chevron" data-open={open ? '' : undefined} />
          <span className="shp-hg__name">{name}</span>
        </button>
        <Badge size="sm" tone={isDeployedTier(group.tier) ? 'attention' : 'neutral'}>
          {TIER_WORDS[group.tier]}
        </Badge>
        <span className="shp-hg__count">{containerCount(group.containers.length)}</span>
        {linkToApp && group.app !== null ? (
          <span className="shp-hg__link">
            <Link asChild>
              <RouterLink to={`/apps/${encodeURIComponent(group.app)}`}>
                Open app <span className="shp-visually-hidden">{group.app}</span>
                <span aria-hidden="true"> ›</span>
              </RouterLink>
            </Link>
          </span>
        ) : null}
      </div>
      {open ? (
        <ul id={listId} className="shp-hg__rows" aria-label={`${name} containers`}>
          {group.containers.map((c) => (
            <ContainerRow key={c.id} container={c} samples={samples} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function ContainerGroups({ groups, samples }: { groups: readonly ContainerGroup[]; samples: HostSnapshot['samples'] }) {
  // The defaults follow the data; a person's own toggle wins for as long as the page is open.
  const defaults = useMemo(() => defaultOpen(groups), [groups]);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  return (
    <ul className="shp-hostgroups" aria-label="Compose projects">
      {groups.map((group) => {
        const open = toggled[group.key] ?? defaults.has(group.key);
        return (
          <Group
            key={group.key}
            group={group}
            open={open}
            samples={samples}
            onToggle={() => {
              setToggled((prev) => ({ ...prev, [group.key]: !open }));
            }}
          />
        );
      })}
    </ul>
  );
}
