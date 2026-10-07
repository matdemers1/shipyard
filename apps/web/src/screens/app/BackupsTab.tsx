import { DataList, DataListRow, Link, Section, Stack } from '@d3cloud/ui';
import { Link as RouterLink } from 'react-router-dom';
import { age, sha7, when, type AppDetail } from '../../lib/appdetail';
import { formatBytes, type RestoreCandidates } from '../../lib/restore';

/**
 * The Backups tab (SHP-T-13.12, SHP-REQ-163), where the old "More" link went: the backups the agent
 * took before its deploys, newest first, and the way into guided restore. Restoring is a confirmed
 * human act on its own page (SHP-D-038); nothing here restores anything. The releases behind a
 * contract migration live here too, because a restore is the only way back to them.
 */

const SHOWN = 5;

export function BackupsTab({ detail, backups }: { detail: AppDetail; backups: RestoreCandidates | null }) {
  const restorePath = `/apps/${encodeURIComponent(detail.name)}/restore`;
  const candidates = backups?.candidates ?? [];
  return (
    <Stack gap="24">
      <Section
        title="Backups"
        description="Backups the agent took before each deploy. Restoring one discards every write made since."
      >
        <Stack gap="12">
          {backups === null ? (
            <p className="shp-status__detail">The backups could not be read just now. The restore page reads them again.</p>
          ) : candidates.length === 0 ? (
            <p className="shp-status__detail">No backups yet. A deploy takes one when the manifest has a backup step.</p>
          ) : (
            <DataList aria-label="Recent backups">
              {candidates.slice(0, SHOWN).map((b) => (
                <DataListRow
                  key={b.backupDeployId}
                  truncate={false}
                  title={`Before ${b.backupDeployKind} ${sha7(b.backupDeploySha)}`}
                  description={`${when(b.createdAt)} · ${formatBytes(b.size)}`}
                  meta={age(b.createdAt)}
                />
              ))}
            </DataList>
          )}
          {backups !== null && backups.limited !== null ? (
            <p className="shp-status__detail">
              A restore completed {age(backups.limited.lastRestoreAt)}; the next one is allowed from {when(backups.limited.freesAt)}.
            </p>
          ) : null}
          <Link asChild>
            <RouterLink to={restorePath}>Backups and restore</RouterLink>
          </Link>
        </Stack>
      </Section>

      {detail.needsRestore.length > 0 ? (
        <Section
          title="Needs a restore"
          headingLevel={3}
          description="A contract migration was deployed after these, so rolling back would break the schema."
        >
          <Stack gap="12">
            <DataList aria-label="Releases that need a restore">
              {detail.needsRestore.map((target) => (
                <DataListRow
                  key={target.deployId}
                  truncate={false}
                  title={<code>{sha7(target.sha)}</code>}
                  description={target.reason}
                  meta={age(target.endedAt)}
                />
              ))}
            </DataList>
            <Link asChild>
              <RouterLink to={restorePath}>Restore from a backup</RouterLink>
            </Link>
          </Stack>
        </Section>
      ) : null}
    </Stack>
  );
}
