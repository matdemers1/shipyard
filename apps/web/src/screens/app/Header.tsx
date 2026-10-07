import { Badge, Button, IconButton, Link, Menu, MenuContent, MenuItem, MenuTrigger, PageHeader } from '@d3cloud/ui';
import { CalendarClock, Ellipsis, History, Smartphone } from 'lucide-react';
import { Link as RouterLink } from 'react-router-dom';
import type { SheetAction } from '../../components/DryRunSheet';
import { FreezeSheet, UnfreezeButton } from '../../components/FreezeSheet';
import { constellationLink } from '../../components/OpenInConstellation';
import { age, liveRequester, repoUrl, sha7, type AppDetail, type FreezeInfo } from '../../lib/appdetail';
import type { AppStatus } from '../../lib/appstatus';
import type { PendingApproval } from '../../lib/home';
import { deployVerb } from '../../lib/words';

/**
 * The app page's header (SHP-T-13.12, SHP-REQ-163): "Apps / bindery", the name with one state
 * badge, what is live and who put it there, and the actions. Exactly one primary: Deploy the newest
 * ready commit, or Review a deploy waiting on approval. Freeze stays one tap away beside it — an
 * emergency brake is never behind a menu (SHP-D-094) — and while the app is frozen, Unfreeze takes
 * the primary's place and Deploy is shown disabled, so the way forward is the obvious one.
 *
 * On a phone the actions ride the foot of the screen above the tab bar (styles.css), where a thumb
 * is; the markup is the same, so there is never a second copy of a button to keep in step.
 */

export function Breadcrumb({ app }: { app: string }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="shp-crumbs">
        <li>
          <Link asChild>
            <RouterLink to="/">Apps</RouterLink>
          </Link>
        </li>
        <li aria-current="page">{app}</li>
      </ol>
    </nav>
  );
}

/**
 * D3 Constellation exists on Apple devices only; iPadOS Safari calls itself a Mac. The same rule as
 * OpenInConstellation's button, which a menu cannot hold.
 */
function onAppleDevice(): boolean {
  return typeof navigator !== 'undefined' && /iPhone|iPad|Macintosh/.test(navigator.userAgent);
}

export interface HeaderProps {
  detail: AppDetail;
  status: AppStatus;
  freeze: FreezeInfo | null;
  approval: PendingApproval | undefined;
  /** A deployer or admin: a viewer sees the facts and none of the actions (SHP-REQ-105). */
  can: boolean;
  /** The commit that would deploy once the app is unfrozen; the disabled Deploy names it. */
  heldSha: string | null;
  onSheet: (action: SheetAction) => void;
  /** A freeze was set or cleared: read the page again. */
  onChanged: () => void;
}

function Meta({ detail }: { detail: AppDetail }) {
  const by = liveRequester(detail);
  const repo = repoUrl(detail.repo);
  return (
    <span className="shp-app-meta">
      <span>
        {detail.liveSha === null ? (
          'Never deployed through Shipyard'
        ) : (
          <>
            Live <code>{sha7(detail.liveSha)}</code> · deployed {age(detail.liveEndedAt)}
            {by !== null ? ` by ${by}` : ''}
          </>
        )}
      </span>
      {repo !== null && detail.repo !== null ? (
        <Link href={repo} target="_blank" rel="noreferrer">
          {detail.repo} ↗
        </Link>
      ) : null}
    </span>
  );
}

/** The one primary, or nothing when there is nothing to do from here. */
function Primary({ detail, status, freeze, approval, heldSha, onSheet }: Omit<HeaderProps, 'can' | 'onChanged'>) {
  // A deploy already holds the app: its own page is where to follow it, linked from the alert.
  if (detail.active !== null) return null;
  if (approval !== undefined) {
    return (
      <Button
        type="button"
        variant="primary"
        onClick={() => {
          onSheet({ kind: 'approve', app: detail.name, sha: approval.sha, deployId: approval.deployId, requester: approval.requester.label });
        }}
      >
        Review {sha7(approval.sha)}
      </Button>
    );
  }
  const ready = status.shipSha;
  if (ready !== null) {
    return (
      <Button
        type="button"
        variant="primary"
        onClick={() => {
          onSheet({ kind: 'deploy', app: detail.name, sha: ready });
        }}
      >
        {deployVerb(ready)}
      </Button>
    );
  }
  // Frozen with a commit ready: shown, so the way forward is visible, and disabled, because a freeze
  // refuses every new deploy and offering one would only lead to a refusal.
  if (freeze !== null && heldSha !== null) {
    return (
      <Button type="button" variant="secondary" disabled>
        {deployVerb(heldSha)}
      </Button>
    );
  }
  return null;
}

function Overflow({ app, can }: { app: string; can: boolean }) {
  const apple = onAppleDevice();
  return (
    <Menu>
      <MenuTrigger>
        <IconButton icon={<Ellipsis />} label={`More for ${app}`} variant="secondary" />
      </MenuTrigger>
      <MenuContent align="end">
        {can ? (
          // The schedule form lives with the schedules list; it names the app and the SHA there.
          <MenuItem asChild icon={<CalendarClock />}>
            <RouterLink to="/activity?kind=schedule">Schedule a deploy…</RouterLink>
          </MenuItem>
        ) : null}
        <MenuItem asChild icon={<History />}>
          <RouterLink to={`/activity?app=${encodeURIComponent(app)}`}>All activity for {app}</RouterLink>
        </MenuItem>
        {apple ? (
          <MenuItem asChild icon={<Smartphone />}>
            <a href={constellationLink(`app/${app}`)}>Open in D3 Constellation</a>
          </MenuItem>
        ) : null}
      </MenuContent>
    </Menu>
  );
}

export function Header(props: HeaderProps) {
  const { detail, status, freeze, can, onChanged } = props;
  return (
    <div className="shp-app-head">
      <div className="shp-app-head__lead">
        <PageHeader
          title={detail.name}
          description={
            <span className="shp-app-meta">
              <Badge tone={status.tone}>{status.label}</Badge>
              <Meta detail={detail} />
            </span>
          }
        />
      </div>
      <div role="group" aria-label={`Actions for ${detail.name}`} className="shp-app-actions">
        {can ? (
          freeze !== null ? (
            <UnfreezeButton app={detail.name} onCleared={onChanged} />
          ) : (
            <FreezeSheet app={detail.name} onFrozen={onChanged} />
          )
        ) : null}
        <Overflow app={detail.name} can={can} />
        <span className="shp-app-actions__main">{can ? <Primary {...props} /> : null}</span>
      </div>
    </div>
  );
}
