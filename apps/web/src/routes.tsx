import { Button, FormActions, Spinner } from '@d3cloud/ui';
import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Shell } from './components/Shell';
import { EntryHeading, EntryShell } from './entry/EntryShell';
import { useAuth, useCan } from './lib/auth';
import { Activity } from './screens/Activity';
import { AcceptInvite } from './screens/AcceptInvite';
import { AppDetail } from './screens/AppDetail';
import { BuildDetail } from './screens/BuildDetail';
import { Commit } from './screens/Commit';
import { Deploy, DeployLiveRedirect } from './screens/Deploy';
import { Home } from './screens/Home';
import { NotFound } from './screens/NotFound';
import { Restore } from './screens/Restore';
import { RolloutProgress } from './screens/RolloutProgress';
import { SettingsSection } from './screens/SettingsSection';
import { Setup } from './screens/Setup';
import { SignIn } from './screens/SignIn';

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
 * Every address the ten-item nav had, and the page that replaced it (SHP-REQ-169, SHP-ADR-006). A
 * bookmark or a link in an old alert email still lands somewhere that makes sense.
 */
export const RETIRED_ROUTES: readonly { from: string; to: string }[] = [
  { from: 'timeline', to: '/activity' },
  { from: 'builds', to: '/activity?kind=build' },
  { from: 'schedules', to: '/activity?kind=schedule' },
  { from: 'system', to: '/settings/host' },
  { from: 'agent', to: '/settings/host' },
  { from: 'tokens', to: '/settings/tokens' },
  { from: 'connect', to: '/settings/tokens' },
  { from: 'users', to: '/settings/people' },
  { from: 'account', to: '/settings/people' },
];

/**
 * Sends a retired address to its replacement, replace-style so Back does not return to the dead
 * route. The visitor's own query and hash survive (a shared link's filter or anchor); the target's
 * own query is kept too, and the visitor's value wins where both name the same key.
 */
export function RetiredRedirect({ to }: { to: string }) {
  const { search, hash } = useLocation();
  const [pathname = '/', targetSearch = ''] = to.split('?');
  const merged = new URLSearchParams(targetSearch);
  new URLSearchParams(search).forEach((value, key) => {
    merged.set(key, value);
  });
  const query = merged.toString();
  return <Navigate to={{ pathname, search: query === '' ? '' : `?${query}`, hash }} replace />;
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

/**
 * Settings opens on the first section the role may see: Host for a deployer or admin, People for a
 * viewer — whose own account lives there — rather than a refusal (SHP-T-13.5 verification).
 */
function SettingsHome() {
  const can = useCan();
  return <Navigate to={can ? '/settings/host' : '/settings/people'} replace />;
}

export function AppRoutes() {
  const { state, refresh } = useAuth();

  // Before anyone is known to be signed in, the console is the front door (SHP-T-9.2): the loading
  // and not-answering states sit in the same entry shell as Sign in, so the page does not jump.
  if (state.status === 'loading') {
    return (
      <EntryShell>
        <EntryHeading title="Shipyard" focusOnMount={false} />
        <Spinner size="lg" label="Loading Shipyard" />
      </EntryShell>
    );
  }

  if (state.status === 'unreachable') {
    return (
      <EntryShell>
        <EntryHeading title={state.error.message}>{state.error.fix}</EntryHeading>
        <div className="shp-entry__body">
          <FormActions layout="stack">
            <Button
              type="button"
              variant="primary"
              size="lg"
              onClick={() => {
                void refresh();
              }}
            >
              Try again
            </Button>
          </FormActions>
        </div>
      </EntryShell>
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
        <Route path="apps/:app/commits/:sha" element={<Commit />} />
        {/* One deploy page that streams and then is the record (SHP-T-13.11); the old live address redirects to it. */}
        <Route path="deploys/:id" element={<Deploy />} />
        <Route path="deploys/:id/live" element={<DeployLiveRedirect />} />
        <Route path="rollouts/:id" element={<RolloutProgress />} />
        <Route path="builds/:id" element={<BuildDetail />} />
        <Route path="activity" element={<Activity />} />
        <Route path="settings" element={<SettingsHome />} />
        <Route path="settings/:section" element={<SettingsSection />} />
        {/* The ten-item nav's addresses, each now a page or a section of one (SHP-REQ-169). */}
        {RETIRED_ROUTES.map(({ from, to }) => (
          <Route key={from} path={from} element={<RetiredRedirect to={to} />} />
        ))}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
