import { EmptyState, Page } from '@d3cloud/ui';
import type { ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { useCan, useIsAdmin } from '../lib/auth';
import { Account } from './Account';
import { Agent } from './Agent';
import { Connect } from './Connect';
import { NotFound } from './NotFound';
import { Settings } from './Settings';
import { System } from './System';
import { Tokens } from './Tokens';
import { Users } from './Users';

/**
 * One section of Settings (SHP-ADR-006): host, tokens, people, integrations, builds. This is the
 * stand-in until SHP-T-13.6 builds the real screen — each section shows the screens that used to
 * be separate pages, behind the same role gates they had.
 */

/**
 * Screens whose whole purpose is changing state (tokens, agent enrolment, users). The nav shows
 * Settings to everyone; this covers what a viewer cannot use.
 */
export function RequireStateChange({ children }: { children: ReactNode }) {
  const can = useCan();
  if (!can) {
    return (
      <Page>
        <EmptyState kind="no-access" heading="This page needs the deployer role" headingLevel={2}>
          Your role is viewer, which can read but not change anything. Ask an admin for the deployer role.
        </EmptyState>
      </Page>
    );
  }
  return children;
}

/** Sign-in settings are an admin's alone, and this covers a typed-in address. */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const isAdmin = useIsAdmin();
  if (!isAdmin) {
    return (
      <Page>
        <EmptyState kind="no-access" heading="This page needs the admin role" headingLevel={2}>
          Settings change how everyone signs in, so only an admin can see them. Ask an admin if something here needs changing.
        </EmptyState>
      </Page>
    );
  }
  return children;
}

export function SettingsSection() {
  const { section = '' } = useParams();
  switch (section) {
    case 'host':
      return (
        <RequireStateChange>
          <System />
          <Agent />
        </RequireStateChange>
      );
    case 'tokens':
      return (
        <>
          <Connect />
          <RequireStateChange>
            <Tokens />
          </RequireStateChange>
        </>
      );
    case 'people':
      return (
        <>
          <RequireStateChange>
            <Users />
          </RequireStateChange>
          <Account />
        </>
      );
    case 'integrations':
      return (
        <RequireAdmin>
          <Settings />
        </RequireAdmin>
      );
    case 'builds':
      return (
        <RequireAdmin>
          <Settings />
        </RequireAdmin>
      );
    default:
      return <NotFound />;
  }
}
