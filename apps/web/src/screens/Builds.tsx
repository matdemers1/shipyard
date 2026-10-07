import { Badge, DataListRow, Link } from '@d3cloud/ui';
import { Link as RouterLink } from 'react-router-dom';
import { TRIGGER_LABEL, buildStateTone, sha7, type BuildSummary } from '../lib/builds';
import { formatRelativeTime } from '../lib/timeline';
import { BUILD_STATE_WORDS } from '../lib/words';

/**
 * One build as a list row: what an app's page lists under its builds. The Builds screen itself is
 * gone — builds are rows in the Activity feed (SHP-T-13.13), and `/builds` redirects there.
 */

export function BuildRow({ build }: { build: BuildSummary }) {
  return (
    <DataListRow
      title={
        <Link asChild>
          <RouterLink to={`/builds/${build.buildId}`}>
            {build.app} · <code>{sha7(build.sha)}</code>
          </RouterLink>
        </Link>
      }
      description={`${TRIGGER_LABEL[build.trigger]} · ${build.requesterLabel}`}
      meta={
        <>
          <Badge tone={buildStateTone(build.state)}>{BUILD_STATE_WORDS[build.state]}</Badge>
          <span>{formatRelativeTime(build.createdAt)}</span>
        </>
      }
    />
  );
}
