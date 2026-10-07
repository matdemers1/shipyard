import { DescriptionItem, DescriptionList, EmptyState, Section, Stack, Textarea } from '@d3cloud/ui';
import { age, builtByShipyard, shortDigest, when, type AppDetail } from '../../lib/appdetail';

/**
 * The Config tab (SHP-T-13.12, SHP-REQ-163): what shapes a deploy of this app, from its manifest on
 * the host; the containers the agent last saw running, by digest; and the manifest itself, read-only.
 * Everything here changes on the host, never from the console.
 */

/** The sorted service → digest pairs the agent reported, for the tab and the rail alike. */
export function runningContainers(detail: Pick<AppDetail, 'running'>): [string, string | null][] {
  return Object.entries(detail.running ?? {}).sort(([a], [b]) => a.localeCompare(b));
}

export function ConfigTab({ detail }: { detail: AppDetail }) {
  const running = runningContainers(detail);
  return (
    <Stack gap="24">
      <Section title="How it deploys" description="The settings that shape a deploy of this app, from its manifest on the host.">
        <DescriptionList>
          <DescriptionItem term="Repository">
            {detail.repo ?? 'None'}
            {detail.defaultBranch !== null ? ` · ${detail.defaultBranch}` : ''}
          </DescriptionItem>
          <DescriptionItem term="Images built by">
            {builtByShipyard(detail.manifest) ? 'Shipyard — each push is built here' : 'GitHub CI — the image workflow on each push'}
          </DescriptionItem>
          <DescriptionItem term="Needs approval">
            {detail.approvalPolicy === 'required' ? 'Yes — a deployer approves every deploy' : 'No — a deployer can deploy directly'}
          </DescriptionItem>
          <DescriptionItem term="Soak time" numeric>
            {detail.soakSeconds !== null ? `${String(detail.soakSeconds)} s watched healthy before a deploy counts as done` : '—'}
          </DescriptionItem>
          <DescriptionItem term="Schema revision">
            {detail.schemaRevision !== null ? <code>{detail.schemaRevision}</code> : 'Not reported by /health'}
          </DescriptionItem>
          <DescriptionItem term="Group">
            {detail.group === null ? 'None — deploys on its own' : detail.canary ? `${detail.group} (canary — deploys first)` : detail.group}
          </DescriptionItem>
          <DescriptionItem term="Agent checked">{age(detail.reportedAt)}</DescriptionItem>
        </DescriptionList>
      </Section>

      <Section
        title="Running containers"
        description={`What the agent saw on the host, ${when(detail.reportedAt)}. A digest names the exact image, so a mismatch here is how drift is found.`}
      >
        {running.length === 0 ? (
          <EmptyState kind="empty" heading="No containers reported" size="inline">
            The agent has not seen a running container for this app.
          </EmptyState>
        ) : (
          <DescriptionList>
            {running.map(([service, digest]) => (
              <DescriptionItem key={service} term={service}>
                <code>{shortDigest(digest)}</code>
              </DescriptionItem>
            ))}
          </DescriptionList>
        )}
      </Section>

      <details className="shp-disclosure">
        <summary>Show the manifest</summary>
        <Stack gap="8">
          <p className="shp-status__detail">As the agent reported it. Read-only: it changes on the host.</p>
          <Textarea
            mono
            readOnly
            aria-label="Manifest"
            rows={12}
            value={typeof detail.manifest === 'string' ? detail.manifest : JSON.stringify(detail.manifest, null, 2)}
          />
        </Stack>
      </details>
    </Stack>
  );
}
