import { Badge, EmptyState, Page, StatusDot } from '@d3cloud/ui';
import type { ReactNode } from 'react';
import { Link as RouterLink, useParams } from 'react-router-dom';
import type { Role } from '../lib/api';
import { canChangeState, useCan, useIsAdmin, useMe } from '../lib/auth';
import { hostWarnings } from '../lib/needsyou';
import { NotFound } from './NotFound';
import { ClaudeTokensSection } from './settings/ClaudeTokensSection';
import { HostSection } from './settings/HostSection';
import { BuildsSection, IntegrationsSection } from './settings/IntegrationsSection';
import { PeopleSection } from './settings/PeopleSection';
import { useBuildUse, useSystemStatus } from './settings/shared';

/**
 * Settings, one destination (SHP-REQ-160, SHP-ADR-006): a sub-nav of five sections — Host, Claude &
 * tokens, People, Integrations, Builds — and the chosen one beside it (above it on a phone). Each
 * section keeps the gate its old screens had: Host needs a state-changing role (System and Agent
 * did), Integrations and Builds are an admin's (Settings was), and Claude & tokens and People are
 * open to everyone, each hiding the part a viewer could not use (Tokens, Users). A section the role
 * cannot open is not listed; a typed address to one is refused in place.
 */

export type SettingsSectionId = 'host' | 'tokens' | 'people' | 'integrations' | 'builds';

type Gate = 'none' | 'state' | 'admin';

interface SectionEntry {
  id: SettingsSectionId;
  label: string;
  group: 'Daily' | 'Connect' | 'Access' | 'Advanced';
  gate: Gate;
}

export const SETTINGS_SECTIONS: readonly SectionEntry[] = [
  { id: 'host', label: 'Host', group: 'Daily', gate: 'state' },
  { id: 'tokens', label: 'Claude & tokens', group: 'Connect', gate: 'none' },
  { id: 'people', label: 'People', group: 'Access', gate: 'none' },
  { id: 'integrations', label: 'Integrations', group: 'Advanced', gate: 'admin' },
  { id: 'builds', label: 'Builds', group: 'Advanced', gate: 'admin' },
];

function allowed(gate: Gate, role: Role | undefined): boolean {
  if (gate === 'admin') return role === 'admin';
  if (gate === 'state') return canChangeState(role);
  return true;
}

/** The sections a role may open, in sub-nav order. The same rule decides the list and the refusal. */
export function sectionsFor(role: Role | undefined): SettingsSectionId[] {
  return SETTINGS_SECTIONS.filter((s) => allowed(s.gate, role)).map((s) => s.id);
}

/**
 * Sections whose whole purpose is changing state (Host: agent enrolment). A typed address is
 * refused here; the sub-nav never offers it to a viewer.
 */
export function RequireStateChange({ children }: { children: ReactNode }) {
  const can = useCan();
  if (!can) {
    return (
      <EmptyState kind="no-access" heading="This page needs the deployer role" headingLevel={2}>
        Your role is viewer, which can read but not change anything. Ask an admin for the deployer role.
      </EmptyState>
    );
  }
  return children;
}

/** Integrations and Builds are an admin's alone, and this covers a typed-in address. */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const isAdmin = useIsAdmin();
  if (!isAdmin) {
    return (
      <EmptyState kind="no-access" heading="This page needs the admin role" headingLevel={2}>
        These settings change how everyone signs in and how the server works, so only an admin can see them. Ask an admin if
        something here needs changing.
      </EmptyState>
    );
  }
  return children;
}

function SettingsNav({
  current,
  role,
  hostNeedsLook,
  buildsUnused,
}: {
  current: SettingsSectionId;
  role: Role | undefined;
  hostNeedsLook: boolean;
  buildsUnused: boolean;
}) {
  const visible = SETTINGS_SECTIONS.filter((s) => allowed(s.gate, role));
  const groups = [...new Set(visible.map((s) => s.group))];
  return (
    <nav aria-label="Settings" className="shp-settings__nav">
      {groups.map((group) => (
        <div key={group} className="shp-settings__group" role="group" aria-labelledby={`shp-settings-group-${group}`}>
          <span id={`shp-settings-group-${group}`} className="shp-settings__group-title">
            {group}
          </span>
          <ul className="shp-settings__list">
            {visible
              .filter((s) => s.group === group)
              .map((s) => (
                <li key={s.id}>
                  <RouterLink
                    to={`/settings/${s.id}`}
                    className="shp-settings__item"
                    aria-current={s.id === current ? 'page' : undefined}
                  >
                    <span className="shp-settings__label">{s.label}</span>
                    {s.id === 'host' && hostNeedsLook ? (
                      <StatusDot tone="warning" size="sm">
                        <span className="shp-visually-hidden">, needs a look</span>
                      </StatusDot>
                    ) : null}
                    {s.id === 'integrations' ? <Badge tone="neutral">Admin</Badge> : null}
                    {s.id === 'builds' && buildsUnused ? <Badge tone="neutral">Unused</Badge> : null}
                  </RouterLink>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function isSectionId(value: string): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((s) => s.id === value);
}

export function SettingsSection() {
  const { section = '' } = useParams();
  const role = useMe()?.role;
  const can = canChangeState(role);
  const isAdmin = role === 'admin';
  // Read once for the frame, so the sub-nav's dot and the Host page never disagree.
  const system = useSystemStatus(can);
  const builds = useBuildUse(isAdmin);

  if (!isSectionId(section)) return <NotFound />;

  let content: ReactNode;
  switch (section) {
    case 'host':
      content = (
        <RequireStateChange>
          <HostSection system={system} />
        </RequireStateChange>
      );
      break;
    case 'tokens':
      content = <ClaudeTokensSection />;
      break;
    case 'people':
      content = <PeopleSection />;
      break;
    case 'integrations':
      content = (
        <RequireAdmin>
          <IntegrationsSection buildUse={builds.use} buildUseLoading={builds.loading} />
        </RequireAdmin>
      );
      break;
    case 'builds':
      content = (
        <RequireAdmin>
          <BuildsSection buildUse={builds.use} buildUseLoading={builds.loading} />
        </RequireAdmin>
      );
      break;
  }

  return (
    <Page>
      <div className="shp-settings">
        <SettingsNav
          current={section}
          role={role}
          hostNeedsLook={hostWarnings(system.status).length > 0}
          buildsUnused={builds.use !== null && builds.use.shipyard.length === 0}
        />
        <div className="shp-settings__content">{content}</div>
      </div>
    </Page>
  );
}
