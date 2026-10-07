import { DescriptionItem, DescriptionList, Link, Section } from '@d3cloud/ui';
import { Link as RouterLink } from 'react-router-dom';
import {
  age,
  builtByShipyard,
  manifestWorkflow,
  repoUrl,
  sha7,
  shortDigest,
  when,
  workflowUrl,
  type AppDetail,
} from '../../lib/appdetail';
import type { RestoreCandidates } from '../../lib/restore';
import type { ScheduleEntry } from '../../lib/schedules';
import { runningContainers } from './ConfigTab';

/**
 * The facts rail (SHP-T-13.12): the app's standing facts at a glance — where it comes from, who
 * builds its images, approval, soak, schema, group, containers, the last backup and when the agent
 * last looked — beside the work on a desktop, and after it on a phone. A "Scheduled" card joins it
 * while a deploy of this app is scheduled.
 */
export function FactsRail({
  detail,
  backups,
  scheduled,
}: {
  detail: AppDetail;
  backups: RestoreCandidates | null;
  /** This app's upcoming schedules, soonest first; empty when none or unreadable. */
  scheduled: ScheduleEntry[];
}) {
  const repo = repoUrl(detail.repo);
  const shipyard = builtByShipyard(detail.manifest);
  const workflow = manifestWorkflow(detail.manifest);
  const actions = workflowUrl(detail.repo, workflow);
  const containers = runningContainers(detail);
  const lastBackup = backups?.candidates[0] ?? null;
  return (
    <aside className="shp-app-rail" aria-label={`About ${detail.name}`}>
      <Section title="Facts" headingLevel={2}>
        <DescriptionList>
          <DescriptionItem term="Repository">
            {repo !== null && detail.repo !== null ? (
              <Link href={repo} target="_blank" rel="noreferrer">
                {detail.repo} ↗
              </Link>
            ) : (
              'None'
            )}
          </DescriptionItem>
          <DescriptionItem term="Images built by">
            {shipyard ? (
              'Shipyard builds'
            ) : actions !== null ? (
              <Link href={actions} target="_blank" rel="noreferrer">
                GitHub Actions{workflow !== null ? ` · ${workflow}` : ''} ↗
              </Link>
            ) : (
              'GitHub Actions'
            )}
          </DescriptionItem>
          <DescriptionItem term="Approval">{detail.approvalPolicy === 'required' ? 'Required' : 'Not required'}</DescriptionItem>
          <DescriptionItem term="Soak" numeric>
            {detail.soakSeconds !== null ? `${String(detail.soakSeconds)} s` : '—'}
          </DescriptionItem>
          <DescriptionItem term="Schema">{detail.schemaRevision !== null ? <code>{detail.schemaRevision}</code> : 'Not reported'}</DescriptionItem>
          <DescriptionItem term="Group">
            {detail.group === null ? 'None' : detail.canary ? `${detail.group} (canary)` : detail.group}
          </DescriptionItem>
          <DescriptionItem term="Containers">
            {containers.length === 0
              ? 'None reported'
              : containers.map(([service, digest]) => (
                  <span key={service} className="shp-app-rail__line">
                    {service} <code>{shortDigest(digest)}</code>
                  </span>
                ))}
          </DescriptionItem>
          <DescriptionItem term="Backups">
            {backups === null ? 'Unknown' : lastBackup === null ? 'None yet' : `Last ${age(lastBackup.createdAt)}`}
          </DescriptionItem>
          <DescriptionItem term="Agent checked">{age(detail.reportedAt)}</DescriptionItem>
        </DescriptionList>
      </Section>

      {scheduled.length > 0 ? (
        <Section title="Scheduled" headingLevel={2}>
          <ul className="shp-app-rail__list">
            {scheduled.map((s) => (
              <li key={s.id}>
                Deploy <code>{sha7(s.sha)}</code> at {when(s.fireAt)}, by {s.by}
              </li>
            ))}
          </ul>
          <Link asChild>
            <RouterLink to="/activity?kind=schedule">Schedules</RouterLink>
          </Link>
        </Section>
      ) : null}
    </aside>
  );
}
