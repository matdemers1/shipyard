import { Button, EmptyState, Page, Spinner } from '@d3cloud/ui';
import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Shell } from './components/Shell';
import { useAuth, useCan } from './lib/auth';
import { AcceptInvite } from './screens/AcceptInvite';
import { Account } from './screens/Account';
import { Agent } from './screens/Agent';
import { AppDetail } from './screens/AppDetail';
import { DeployProgress } from './screens/DeployProgress';
import { DeployRecord } from './screens/DeployRecord';
import { Home } from './screens/Home';
import { NotFound } from './screens/NotFound';
import { Restore } from './screens/Restore';
import { Schedules } from './screens/Schedules';
import { Setup } from './screens/Setup';
import { SignIn } from './screens/SignIn';
import { System } from './screens/System';
import { Timeline } from './screens/Timeline';
import { Tokens } from './screens/Tokens';
import { Users } from './screens/Users';

/**
 * The route table. It is the only file that names every screen, so a later task changes its own
 * screen file and nothing here.
 */

interface FromState {
  from?: string;
}

/** True while the server has no account at all: the console offers first-run setup (SHP-REQ-109). */
function useSetupAvailable(): boolean {
  const { state } = useAuth();
  return state.status === 'signed-out' && state.setupAvailable === true;
}

/**
 * Signed-out visitors go to sign-in, remembering where they were going — or, on a server with no
 * account yet, to first-run setup.
 */
function RequireSession({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const location = useLocation();
  const setupAvailable = useSetupAvailable();
  if (setupAvailable) return <Navigate to="/setup" replace />;
  if (state.status !== 'signed-in') {
    const from = `${location.pathname}${location.search}`;
    return <Navigate to="/signin" replace state={{ from } satisfies FromState} />;
  }
  return children;
}

/**
 * Screens whose whole purpose is changing state (tokens, agent enrolment, users). The nav hides
 * them from a viewer; this covers a typed-in address.
 */
function RequireStateChange({ children }: { children: ReactNode }) {
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

function SignInRoute() {
  const { state, refresh } = useAuth();
  const location = useLocation();
  if (state.status === 'signed-in') {
    const from = (location.state as FromState | null)?.from;
    return <Navigate to={from !== undefined && from.startsWith('/') && from !== '/signin' ? from : '/'} replace />;
  }
  // A fresh install has nobody to sign in as: create the first account instead.
  if (state.status === 'signed-out' && state.setupAvailable === true) return <Navigate to="/setup" replace />;
  return <SignIn onSignedIn={refresh} />;
}

/** Public, and only while no account exists; otherwise it is sign-in's (or home's) job. */
function SetupRoute() {
  const { state, refresh } = useAuth();
  if (state.status === 'signed-in') return <Navigate to="/" replace />;
  if (state.status !== 'signed-out' || state.setupAvailable !== true) return <Navigate to="/signin" replace />;
  return <Setup onSignedIn={refresh} onClosed={refresh} />;
}

export function AppRoutes() {
  const { state, refresh } = useAuth();

  if (state.status === 'loading') {
    return (
      <div className="shp-center">
        <Spinner size="lg" label="Loading Shipyard" />
      </div>
    );
  }

  if (state.status === 'unreachable') {
    return (
      <Page as="main" align="center" width="form">
        <div className="shp-center">
          <EmptyState
            kind="error"
            heading={state.error.message}
            headingLevel={2}
            action={
              <Button
                type="button"
                onClick={() => {
                  void refresh();
                }}
              >
                Try again
              </Button>
            }
          >
            {state.error.fix}
          </EmptyState>
        </div>
      </Page>
    );
  }

  return (
    <Routes>
      <Route path="/signin" element={<SignInRoute />} />
      <Route path="/setup" element={<SetupRoute />} />
      {/* Public: an invite link is opened by someone who has no account yet (SHP-REQ-067). */}
      <Route path="/invite/:token" element={<AcceptInvite />} />
      <Route
        element={
          <RequireSession>
            <Shell />
          </RequireSession>
        }
      >
        <Route index element={<Home />} />
        <Route path="apps/:app" element={<AppDetail />} />
        <Route path="apps/:app/restore" element={<Restore />} />
        <Route path="deploys/:id" element={<DeployRecord />} />
        <Route path="deploys/:id/live" element={<DeployProgress />} />
        <Route path="timeline" element={<Timeline />} />
        <Route path="schedules" element={<Schedules />} />
        <Route
          path="system"
          element={
            <RequireStateChange>
              <System />
            </RequireStateChange>
          }
        />
        <Route path="account" element={<Account />} />
        <Route
          path="agent"
          element={
            <RequireStateChange>
              <Agent />
            </RequireStateChange>
          }
        />
        <Route
          path="tokens"
          element={
            <RequireStateChange>
              <Tokens />
            </RequireStateChange>
          }
        />
        <Route
          path="users"
          element={
            <RequireStateChange>
              <Users />
            </RequireStateChange>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
