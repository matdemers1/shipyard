import { Link, PageHeader, Section, Spinner, Stack } from '@d3cloud/ui';
import { Link as RouterLink } from 'react-router-dom';
import { AlertEmailSettings } from '../AlertEmailSettings';
import { BuildSettingsSection } from '../BuildSettings';
import { GitHubSettingsSection } from '../GitHubSettings';
import { D3AuthCard } from '../Settings';
import { unusedBuildsLine, type BuildUse } from './shared';

/**
 * Settings › Integrations (SHP-ADR-006, SHP-D-090): everything the server talks to — Sign in with
 * D3 Auth, the server's GitHub read token and alert email — as compact cards whose forms open in
 * place. Admin-only, as the old Settings screen was. The BuildKit limits live in Builds alone
 * (SHP-REQ-170); this page only says whether any app uses them and links there.
 */

function BuildsPointer({ use }: { use: BuildUse | null }) {
  const line =
    use === null
      ? 'Whether any app builds with Shipyard could not be read.'
      : use.shipyard.length === 0
        ? unusedBuildsLine(use)
        : `${use.shipyard.join(', ')} ${use.shipyard.length === 1 ? 'builds' : 'build'} with Shipyard.`;
  return (
    <Section
      title="Builds"
      description="BuildKit's CPU, memory and cache cap, for apps whose images Shipyard builds itself."
      actions={
        <Link asChild>
          <RouterLink to="/settings/builds">Open Builds</RouterLink>
        </Link>
      }
    >
      <p className="shp-status__detail">{line}</p>
    </Section>
  );
}

export function IntegrationsSection({ buildUse, buildUseLoading }: { buildUse: BuildUse | null; buildUseLoading: boolean }) {
  return (
    <Stack gap="24">
      <PageHeader title="Integrations" description="Sign-in, GitHub and alert email: how this server reaches the services around it." />
      <D3AuthCard />
      <GitHubSettingsSection />
      <AlertEmailSettings />
      {buildUseLoading ? <Spinner label="Checking which apps build with Shipyard" /> : <BuildsPointer use={buildUse} />}
    </Stack>
  );
}

export function BuildsSection({ buildUse, buildUseLoading }: { buildUse: BuildUse | null; buildUseLoading: boolean }) {
  const unused = buildUse !== null && buildUse.shipyard.length === 0 ? unusedBuildsLine(buildUse) : null;
  return (
    <Stack gap="24">
      <PageHeader
        title="Builds"
        description={
          buildUse !== null && buildUse.shipyard.length > 0
            ? `For the apps whose images Shipyard builds: ${buildUse.shipyard.join(', ')}.`
            : 'For apps whose images Shipyard builds itself (build: shipyard).'
        }
      />
      {buildUseLoading ? <Spinner label="Checking which apps build with Shipyard" /> : <BuildSettingsSection unusedLine={unused} />}
    </Stack>
  );
}
