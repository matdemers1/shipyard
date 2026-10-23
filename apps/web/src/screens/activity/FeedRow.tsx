import { Badge, Link } from '@d3cloud/ui';
import type { ActionStatus, MaintenanceStatus, StackUpdateStatus } from '@shipyard/schema';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { PipeNode } from '../../components/pipeline';
import { actionBadgeWords, actionDuration, actionScope, actionStateWords } from '../../lib/actions';
import { sha7 } from '../../lib/appdetail';
import { TRIGGER_LABEL } from '../../lib/builds';
import { bytes, maintenanceStateWords } from '../../lib/maintenance';
import { changeWords, outcomeTone, requesterLine, stackUpdateStateWords } from '../../lib/stacks';
import { formatDuration, formatFeedTime } from '../../lib/timeline';
import {
  DEPLOY_ALL_READY,
  IMAGES_AND_CACHE,
  MAINTENANCE_DONE_WORDS,
  MAINTENANCE_KIND_WORDS,
  VOLUME_WORDS,
  backedUpDetailWords,
  dryRunWords,
  freedWords,
  stackChangeWords,
} from '../../lib/words';
import {
  actionNode,
  buildHeadline,
  buildNode,
  deployHeadline,
  deployNode,
  deployRequester,
  durationBetween,
  maintenanceNode,
  requesterWords,
  rolloutSummary,
  scheduleHeadline,
  stackUpdateNode,
  type FeedEntry,
} from './model';
import type { StageState } from '../../components/pipeline';
import type { TimelineItem } from '../../lib/timeline';

/**
 * One row of the Activity feed (SHP-T-13.13): a status node, the app and short SHA, the verb with
 * its outcome, who asked, how long it took and when. The whole row is the link, so a thumb has the
 * full width to hit. A rollout is one row that opens to its deploys in order.
 */

interface RowProps {
  node: StageState;
  to: string;
  app: string;
  sha: string | null;
  headline: string;
  detail: string;
  duration: string | null;
  at: string;
  now: Date;
  /** For the member rows inside a rollout, where the app leads and the requester is the rollout's. */
  nested?: boolean;
}

function Row({ node, to, app, sha, headline, detail, duration, at, now, nested = false }: RowProps) {
  return (
    <li className="shp-feed-row" data-nested={nested ? '' : undefined}>
      <PipeNode state={node} size="sm" />
      <Link asChild>
        <RouterLink to={to} className="shp-feed-row__link">
          <span className="shp-feed-row__line">
            <strong>{app}</strong>
            {sha !== null ? <code>{sha7(sha)}</code> : null}
            <span className="shp-feed-row__verb">{headline}</span>
          </span>
          <span className="shp-feed-row__sub">{[detail, duration].filter((x): x is string => x !== null && x !== '').join(' · ')}</span>
        </RouterLink>
      </Link>
      <time className="shp-feed-row__time" dateTime={at} title={new Date(at).toLocaleString()}>
        {formatFeedTime(at, now)}
      </time>
    </li>
  );
}

function DeployRow({ item, now, nested = false, detail }: { item: TimelineItem; now: Date; nested?: boolean; detail?: string }) {
  return (
    <Row
      node={deployNode(item.state)}
      to={`/deploys/${item.deployId}`}
      app={item.app}
      sha={item.sha}
      headline={deployHeadline(item)}
      detail={detail ?? deployRequester(item)}
      duration={durationBetween(item.createdAt, item.endedAt)}
      at={item.createdAt}
      now={now}
      nested={nested}
    />
  );
}

/** Where an action's row goes: the app's page, or Host's Operated stacks. */
function actionHref(action: ActionStatus): string {
  return action.target.kind === 'app' ? `/apps/${encodeURIComponent(action.target.name)}` : '/host?tier=operated';
}

/** "worker · done in 8s", "the whole stack · Agent too old", "worker · Queued". */
export function actionDetail(action: ActionStatus): string {
  const scope = actionScope(action);
  switch (action.state) {
    case 'succeeded': {
      const duration = actionDuration(action);
      return duration === null ? `${scope} · done` : `${scope} · done in ${duration}`;
    }
    case 'refused':
      return `${scope} · ${action.refusal?.message ?? actionStateWords('refused')}`;
    case 'failed':
      return `${scope} · ${action.refusal?.message ?? 'failed'}`;
    default:
      return `${scope} · ${actionStateWords(action.state)}`;
  }
}

/**
 * A lifecycle action (SHP-T-15.7, SHP-ADR-010): the app or stack, a badge with what was done —
 * "Restarted" — the service and how it went, who asked and when. On a desktop the requester sits
 * beside the time; on a phone, under the name.
 */
function ActionRow({ action, at, now }: { action: ActionStatus; at: string; now: Date }) {
  const who = requesterWords(action.requesterLabel);
  const tone = action.state === 'failed' || action.state === 'refused' ? 'danger' : 'neutral';
  return (
    <li className="shp-feed-row">
      <PipeNode state={actionNode(action.state)} size="sm" />
      <Link asChild>
        <RouterLink to={actionHref(action)} className="shp-feed-row__link">
          <span className="shp-feed-row__line">
            <strong>{action.target.name}</strong>
            <Badge size="sm" tone={tone}>
              {actionBadgeWords(action)}
            </Badge>
          </span>
          <span className="shp-feed-row__sub">
            {actionDetail(action)}
            <span className="shp-feed-row__who-inline"> · {who}</span>
          </span>
        </RouterLink>
      </Link>
      <span className="shp-feed-row__who">{who}</span>
      <time className="shp-feed-row__time" dateTime={at} title={new Date(at).toLocaleString()}>
        {formatFeedTime(at, now)}
      </time>
    </li>
  );
}

/**
 * "Update 17.1.1 → 17.1.2", "Rollback · 17.0.4" and — when it did not work — the refusal's message
 * and fix verbatim (SHP-REQ-200).
 */
export function stackUpdateDetail(update: StackUpdateStatus): string {
  const change = stackChangeWords(update.kind, changeWords(update));
  const why = update.state === 'succeeded' || update.refusal === null ? [] : [update.refusal.message, update.refusal.fix];
  return [change, ...why].join(' · ');
}

/**
 * A stack update or rollback (SHP-T-16.6, SHP-REQ-200): the stack, its outcome as a badge, what
 * moved and — when it did not work — the refusal's message, who asked (and approved) and when. The
 * row opens the stack's history on Host.
 */
function StackUpdateRow({ update, at, now }: { update: StackUpdateStatus; at: string; now: Date }) {
  const who = requesterLine(update);
  return (
    <li className="shp-feed-row">
      <PipeNode state={stackUpdateNode(update.state)} size="sm" />
      <Link asChild>
        <RouterLink to={`/host?stack=${encodeURIComponent(update.stack)}`} className="shp-feed-row__link">
          <span className="shp-feed-row__line">
            <strong>{update.stack}</strong>
            <Badge size="sm" tone={outcomeTone(update.state)}>
              {stackUpdateStateWords(update.state)}
            </Badge>
          </span>
          <span className="shp-feed-row__sub">
            {stackUpdateDetail(update)}
            <span className="shp-feed-row__who-inline"> · {who}</span>
          </span>
        </RouterLink>
      </Link>
      <span className="shp-feed-row__who">{who}</span>
      <time className="shp-feed-row__time" dateTime={at} title={new Date(at).toLocaleString()}>
        {formatFeedTime(at, now)}
      </time>
    </li>
  );
}

/** A dry run is a prune that lists; a real one removes. */
function isDryRun(job: MaintenanceStatus): boolean {
  return job.kind === 'prune' && job.prune !== null && job.prune.reclaimedBytes === null;
}

/** The badge: what it did once it worked ("Backed up", "Dry run"), else the job and its state. */
export function maintenanceBadge(job: MaintenanceStatus): string {
  if (job.state === 'succeeded') return isDryRun(job) ? VOLUME_WORDS.dryRun : MAINTENANCE_DONE_WORDS[job.kind];
  return [MAINTENANCE_KIND_WORDS[job.kind], maintenanceStateWords(job.state)].join(' · ');
}

/** What it came to — the archive, what a prune freed or found — and, when it did not work, the refusal verbatim. */
export function maintenanceDetail(job: MaintenanceStatus): string {
  if (job.state !== 'succeeded') return job.refusal === null ? '' : [job.refusal.message, job.refusal.fix].join(' · ');
  if (job.kind === 'volume-backup' && job.archive !== null) {
    return [bytes(job.archive.sizeBytes), backedUpDetailWords(job.archive.quiesced, job.removedArchives.length)].join(' · ');
  }
  if (job.kind === 'prune' && job.prune !== null) {
    return job.prune.reclaimedBytes === null ? dryRunWords(job.prune.items.length, bytes(job.prune.reclaimableBytes)) : freedWords(bytes(job.prune.reclaimedBytes));
  }
  return '';
}

/**
 * A volume backup, restore, delete or a prune (SHP-T-17.6, SHP-ADR-012): the volume (or "Images and
 * build cache"), a badge with what was done, what it came to or the refusal's message and fix, who
 * asked and when. The row opens the volume on Host, or Host for a prune.
 */
function MaintenanceRow({ job, at, now }: { job: MaintenanceStatus; at: string; now: Date }) {
  const who = requesterWords(job.requester.label);
  const tone = job.state === 'failed' || job.state === 'refused' ? 'danger' : 'neutral';
  const detail = maintenanceDetail(job);
  const to = job.volume === null ? '/host' : `/host?volume=${encodeURIComponent(job.volume)}`;
  return (
    <li className="shp-feed-row">
      <PipeNode state={maintenanceNode(job.state)} size="sm" />
      <Link asChild>
        <RouterLink to={to} className="shp-feed-row__link">
          <span className="shp-feed-row__line">
            <strong>{job.volume ?? IMAGES_AND_CACHE}</strong>
            <Badge size="sm" tone={tone}>
              {maintenanceBadge(job)}
            </Badge>
          </span>
          <span className="shp-feed-row__sub">
            {detail}
            <span className="shp-feed-row__who-inline">
              {detail === '' ? '' : ' · '}
              {who}
            </span>
          </span>
        </RouterLink>
      </Link>
      <span className="shp-feed-row__who">{who}</span>
      <time className="shp-feed-row__time" dateTime={at} title={new Date(at).toLocaleString()}>
        {formatFeedTime(at, now)}
      </time>
    </li>
  );
}

function RolloutRow({ entry, now }: { entry: Extract<FeedEntry, { type: 'rollout' }>; now: Date }) {
  const [open, setOpen] = useState(false);
  const { members, total } = entry;
  const { node, words } = rolloutSummary(members, total);
  const finished = members.every((m) => m.item.endedAt !== null);
  const started = members.reduce<number>((min, m) => Math.min(min, Date.parse(m.item.createdAt)), Infinity);
  const ended = members.reduce<number>((max, m) => Math.max(max, Date.parse(m.item.endedAt ?? m.item.createdAt)), 0);
  const duration = finished && ended - started >= 1000 ? formatDuration(ended - started) : null;
  const name = `${DEPLOY_ALL_READY} · ${String(total)} ${total === 1 ? 'app' : 'apps'}`;
  const panel = `rollout-${entry.key}`;
  return (
    <li className="shp-feed-row shp-feed-row--rollout">
      <div className="shp-feed-row__rollhead">
        <PipeNode state={node} size="sm" />
        <button
          type="button"
          className="shp-feed-row__toggle"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => {
            setOpen((v) => !v);
          }}
        >
          <ChevronRight aria-hidden="true" size={16} className="shp-feed-row__chevron" data-open={open ? '' : undefined} />
          <span className="shp-feed-row__link">
            <span className="shp-feed-row__line">
              <strong>{name}</strong>
            </span>
            <span className="shp-feed-row__sub">{[requesterWords(entry.requester), duration, words].filter((x): x is string => x !== null).join(' · ')}</span>
          </span>
        </button>
        <time className="shp-feed-row__time" dateTime={entry.at} title={new Date(entry.at).toLocaleString()}>
          {formatFeedTime(entry.at, now)}
        </time>
      </div>
      <ul id={panel} className="shp-feed-rollout" aria-label={`${name} deploys`} hidden={!open}>
        {members.map((m) => (
          <DeployRow key={m.item.deployId} item={m.item} now={now} nested detail={`${String(m.position)} of ${String(total)}`} />
        ))}
      </ul>
    </li>
  );
}

export function FeedRow({ entry, now }: { entry: FeedEntry; now: Date }) {
  switch (entry.type) {
    case 'deploy':
      return <DeployRow item={entry.item} now={now} />;
    case 'rollout':
      return <RolloutRow entry={entry} now={now} />;
    case 'build':
      return (
        <Row
          node={buildNode(entry.build.state)}
          to={`/builds/${entry.build.buildId}`}
          app={entry.build.app}
          sha={entry.build.sha}
          headline={buildHeadline(entry.build)}
          detail={`${TRIGGER_LABEL[entry.build.trigger]} · ${entry.build.requesterLabel}`}
          duration={durationBetween(entry.build.startedAt, entry.build.endedAt)}
          at={entry.at}
          now={now}
        />
      );
    case 'action':
      return <ActionRow action={entry.action} at={entry.at} now={now} />;
    case 'stack-update':
      return <StackUpdateRow update={entry.update} at={entry.at} now={now} />;
    case 'maintenance':
      return <MaintenanceRow job={entry.job} at={entry.at} now={now} />;
    case 'schedule':
      return (
        <Row
          node={buildScheduleNode(entry.entry.state, entry.entry.status === 'cancelled')}
          to={`/deploys/${entry.entry.deployId}`}
          app={entry.entry.app}
          sha={entry.entry.sha}
          headline={scheduleHeadline(entry.entry)}
          detail={requesterWords(`${entry.entry.by} (scheduled)`)}
          duration={null}
          at={entry.at}
          now={now}
        />
      );
  }
}

function buildScheduleNode(state: TimelineItem['state'], cancelled: boolean): StageState {
  return cancelled ? 'skipped' : deployNode(state);
}
