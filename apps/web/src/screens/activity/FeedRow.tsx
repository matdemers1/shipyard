import { Link } from '@d3cloud/ui';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { PipeNode } from '../../components/pipeline';
import { sha7 } from '../../lib/appdetail';
import { TRIGGER_LABEL } from '../../lib/builds';
import { formatDuration, formatFeedTime } from '../../lib/timeline';
import { DEPLOY_ALL_READY } from '../../lib/words';
import {
  buildHeadline,
  buildNode,
  deployHeadline,
  deployNode,
  deployRequester,
  durationBetween,
  requesterWords,
  rolloutSummary,
  scheduleHeadline,
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
