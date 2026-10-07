import { Link } from '@d3cloud/ui';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { Builds } from './Builds';
import { Schedules } from './Schedules';
import { Timeline } from './Timeline';

/**
 * Activity: the one place for what has happened and what is coming (SHP-ADR-006). This is the
 * stand-in until SHP-T-13.13 builds the real screen. It shows the three screens it absorbs, one at
 * a time, chosen by `?kind=` — the address the old Builds and Schedules routes redirect to — so
 * nothing is unreachable while the nav is three items. (Timeline's own `kind` filter names
 * deploys, so only these two values mean something else.)
 */
export function Activity() {
  const [params] = useSearchParams();
  const kind = params.get('kind');
  return (
    <>
      <div className="shp-action-row">
        <Link asChild>
          <RouterLink to="/activity">Deploys</RouterLink>
        </Link>
        <Link asChild>
          <RouterLink to="/activity?kind=build">Builds</RouterLink>
        </Link>
        <Link asChild>
          <RouterLink to="/activity?kind=schedule">Schedules</RouterLink>
        </Link>
      </div>
      {kind === 'build' ? <Builds /> : kind === 'schedule' ? <Schedules /> : <Timeline />}
    </>
  );
}
