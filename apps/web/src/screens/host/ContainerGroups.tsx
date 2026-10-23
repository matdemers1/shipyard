import { Badge, Button, Link, StatusDot } from '@d3cloud/ui';
import type { HostContainer, HostSnapshot } from '@shipyard/schema';
import { ChevronRight } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Link as RouterLink, useNavigate, type NavigateFunction, type To } from 'react-router-dom';
import { canAct, isBusy, targetFor, useAction } from '../../lib/actions';
import { useMe } from '../../lib/auth';
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
import { candidates, checkError, runningTag, stackUpdateStateWords, stackUpdateStepWords, versionWords, type StackView } from '../../lib/stacks';
import { RESTART_STACK, STACK_HISTORY, TIER_WORDS, UPDATE_STACK, checkFailedWords, historyOfWords, updateAvailableWords, updateStackLabel } from '../../lib/words';
import { ActionProgress } from './ActionProgress';
import { Sparkline } from './Sparkline';

/**
 * The Host destination's containers (SHP-REQ-178): one group per compose project, Deployed first,
 * then Operated, then Observed, and the containers compose did not create last. A group opens by
 * default when something in it is not running or unhealthy; when all is well, only the first does.
 * A container's name opens its sheet (SHP-T-15.7) — logs, and lifecycle actions where its tier
 * allows them; a Deployed or Operated group's header offers "Restart stack" for the whole compose
 * project to a deployer and above (SHP-REQ-184), and an Observed group offers nothing (SHP-REQ-185).
 *
 * An Operated stack adopted with `updates: digest` (SHP-T-16.6, SHP-ADR-010) also says on its header
 * what the agent found (SHP-REQ-194) — "Update available · 17.1.1 → 17.1.2", or that a check failed —
 * and offers "Update…" to a deployer and above, and its history to anyone.
 */

/** Where a stack's sheet is: its history, or with `update` its update sheet. */
export type StackHref = (name: string, update: boolean) => To;

/** Where a container's row goes: the same page with `?container=<id>`, so Back closes the sheet. */
export type ContainerHref = (id: string) => To;

export const NO_COMPOSE_NAME = 'Not in a compose project';

function containerCount(n: number): string {
  return `${String(n)} ${n === 1 ? 'container' : 'containers'}`;
}

function ContainerRow({ container, samples, hrefFor }: { container: HostContainer; samples: HostSnapshot['samples']; hrefFor: ContainerHref }) {
  const status = containerStatus(container);
  return (
    <li className="shp-hc">
      <span className="shp-hc__name">
        {/* The name is the link; its hit area covers the whole row (styles.css), so a thumb can tap anywhere on it. */}
        <RouterLink to={hrefFor(container.id)} state={{ sheet: true }} className="shp-hc__title shp-hc__open">
          {container.name}
        </RouterLink>
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

/** "Restart stack": the whole compose project, no service, with the same progress as a container's actions. */
function RestartStack({ group, name }: { group: ContainerGroup; name: string }) {
  const { phase, run } = useAction();
  const target = targetFor(group.tier, group.app);
  if (target === null) return null;
  return (
    <>
      <span className="shp-hg__act">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={isBusy(phase)}
          onClick={() => {
            run({ target, verb: 'restart' });
          }}
        >
          {RESTART_STACK} <span className="shp-visually-hidden">{name}</span>
        </Button>
      </span>
      {phase.kind === 'idle' ? null : (
        <div className="shp-hg__progress">
          <ActionProgress phase={phase} />
        </div>
      )}
    </>
  );
}

/** The badge a digest-updated stack's header carries: what runs now, or the candidate. */
function updateBadge(stack: StackView, group: ContainerGroup): string | null {
  const active = stack.activeUpdate;
  if (active !== null) return active.step === null ? stackUpdateStateWords(active.state) : stackUpdateStepWords(active.step);
  const first = candidates(stack)[0];
  if (first === undefined || first.candidate === null) return null;
  const known = stack.lastUpdate === null ? [] : [stack.lastUpdate];
  const from = versionWords(runningTag(first, known, group.containers, stack.composeProject), first.running);
  return updateAvailableWords(from, first.candidate.tag);
}

/** The Operated stack's own controls: the candidate badge, a failed check, History and "Update…". */
function stackControls(stack: StackView, group: ContainerGroup, mayAct: boolean, stackHref: StackHref, navigate: NavigateFunction, busy: boolean) {
  const badge = updateBadge(stack, group);
  const error = checkError(stack);
  // Never a second request while one is under way: the server's, or the open sheet's own.
  const offer = mayAct && !busy && stack.activeUpdate === null && candidates(stack).length > 0;
  return {
    badge:
      badge === null ? null : (
        <Badge size="sm" tone={stack.activeUpdate?.state === 'awaiting_approval' ? 'warning' : 'attention'}>
          {badge}
        </Badge>
      ),
    links: (
      <span className="shp-hg__history">
        <Link asChild>
          <RouterLink to={stackHref(stack.name, false)} state={{ sheet: true }} aria-label={historyOfWords(stack.name)}>
            {STACK_HISTORY}
          </RouterLink>
        </Link>
      </span>
    ),
    update: offer ? (
      <span className="shp-hg__update">
        <Button
          type="button"
          size="sm"
          variant="primary"
          aria-label={updateStackLabel(stack.name)}
          onClick={() => {
            void navigate(stackHref(stack.name, true), { state: { sheet: true } });
          }}
        >
          {UPDATE_STACK}
        </Button>
      </span>
    ) : null,
    note: error === null ? null : <p className="shp-hg__note">{checkFailedWords(error)}</p>,
  };
}

function Group({
  group,
  open,
  onToggle,
  samples,
  hrefFor,
  mayAct,
  stack,
  stackHref,
  busyStacks,
}: {
  group: ContainerGroup;
  open: boolean;
  onToggle: () => void;
  samples: HostSnapshot['samples'];
  hrefFor: ContainerHref;
  mayAct: boolean;
  stack: StackView | undefined;
  stackHref: StackHref | undefined;
  busyStacks: ReadonlySet<string> | undefined;
}) {
  const listId = useId();
  const name = group.project ?? NO_COMPOSE_NAME;
  const linkToApp = isDeployedTier(group.tier) && group.app !== null;
  const navigate = useNavigate();
  const updates = stack !== undefined && stack.updates === 'digest' && stackHref !== undefined ? stackControls(stack, group, mayAct, stackHref, navigate, busyStacks?.has(stack.name) === true) : null;
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
        {updates?.badge ?? null}
        {updates?.links ?? null}
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
        {mayAct && group.project !== null ? <RestartStack group={group} name={name} /> : null}
        {updates?.update ?? null}
        {updates?.note ?? null}
      </div>
      {open ? (
        <ul id={listId} className="shp-hg__rows" aria-label={`${name} containers`}>
          {group.containers.map((c) => (
            <ContainerRow key={c.id} container={c} samples={samples} hrefFor={hrefFor} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** The adopted stack a group is, by the name its containers carry, else by its compose project. */
export function stackForGroup(group: ContainerGroup, stacks: ReadonlyMap<string, StackView> | undefined): StackView | undefined {
  if (stacks === undefined || group.tier !== 'operated') return undefined;
  const named = group.app === null ? undefined : stacks.get(group.app);
  return named ?? [...stacks.values()].find((s) => s.composeProject === group.project);
}

export function ContainerGroups({
  groups,
  samples,
  hrefFor,
  stacks,
  stackHref,
  busyStacks,
}: {
  groups: readonly ContainerGroup[];
  samples: HostSnapshot['samples'];
  hrefFor: ContainerHref;
  /** Adopted stacks by name (SHP-T-16.6); absent or empty on a server without stack updates. */
  stacks?: ReadonlyMap<string, StackView>;
  stackHref?: StackHref;
  /** Stacks whose open sheet is asking for an update right now. */
  busyStacks?: ReadonlySet<string>;
}) {
  const mayAct = canAct(useMe()?.role);
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
            hrefFor={hrefFor}
            mayAct={mayAct}
            stack={stackForGroup(group, stacks)}
            stackHref={stackHref}
            busyStacks={busyStacks}
            onToggle={() => {
              setToggled((prev) => ({ ...prev, [group.key]: !open }));
            }}
          />
        );
      })}
    </ul>
  );
}
