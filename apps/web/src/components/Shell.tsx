import {
  AccountMenu,
  AppShell,
  AppShellBrand,
  IconButton,
  MenuItem,
  MenuSeparator,
  SideNav,
  SideNavItem,
  StatusDot,
  TabBar,
  ThemeSwitch,
  useTheme,
} from '@d3cloud/ui';
import { Moon, Sun } from 'lucide-react';
import { useSyncExternalStore, type ReactNode } from 'react';
import { Link as RouterLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ShipyardMark } from '../brand/ShipyardMark';
import { useAuth, useCan, useMe } from '../lib/auth';
import { useNeedsYou } from '../lib/needsyou';
import { NAV_ITEMS, isNavCurrent } from '../nav';

/**
 * The signed-in frame: the design system's AppShell. At `lg` and up a sidebar; below it (every
 * phone, 375 px included) a top bar and a bottom tab bar — no horizontal scroll. The three
 * destinations are the same in both (SHP-REQ-159).
 */

/** Light ↔ dark in one tap. The account menu also offers "system". */
export function ThemeToggle() {
  const { resolved, setPreference } = useTheme();
  const next = resolved === 'dark' ? 'light' : 'dark';
  return (
    <IconButton
      icon={resolved === 'dark' ? <Sun /> : <Moon />}
      label={`Switch to ${next} theme`}
      size="sm"
      onClick={() => {
        setPreference(next);
      }}
    />
  );
}

/** True from `lg` up, the AppShell's own line between sidebar and drawer, which is also where the tab bar hides. */
const WIDE = '(min-width: 1024px)';

function subscribeWide(onChange: () => void): () => void {
  const query = window.matchMedia(WIDE);
  query.addEventListener('change', onChange);
  return () => {
    query.removeEventListener('change', onChange);
  };
}

function useWide(): boolean {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
}

/**
 * The sidebar's footer line: whether the host needs a look, linking to where it is shown. It reads
 * the same status the Apps badge does, so a deployer sees a stale agent or an expiring token
 * without opening Settings. One line says what; more than one says how many.
 */
function HostHealth({ warnings }: { warnings: readonly string[] }) {
  const first = warnings[0];
  return (
    <RouterLink to="/settings/host" className="shp-host">
      <StatusDot tone={first === undefined ? 'idle' : 'warning'} size="sm">
        <span className="shp-host__label">{first === undefined ? 'Host healthy' : `Host · ${String(warnings.length)} to look at`}</span>
      </StatusDot>
      {first === undefined ? null : <span className="shp-host__line">{first}</span>}
    </RouterLink>
  );
}

export function Shell({ children }: { children?: ReactNode }) {
  const me = useMe();
  const can = useCan();
  const { signOut } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  const isAdmin = me?.role === 'admin';
  const items = NAV_ITEMS.filter((item) => (!item.needsStateChange || can) && (item.needsAdmin !== true || isAdmin));
  const wide = useWide();
  const needsYou = useNeedsYou(can);
  // countLabel replaces a link's whole accessible name, so it must still say where it goes.
  const countFor = (to: string) =>
    to === '/' && needsYou.count > 0 ? { count: needsYou.count, countLabel: `Apps, ${String(needsYou.count)} need you` } : {};
  const email = me?.email ?? '';

  return (
    <AppShell
      storageKey="shipyard.nav"
      mainId="main"
      brand={
        <AppShellBrand asChild name="Shipyard" mark={<ShipyardMark decorative className="shp-brand-mark" />}>
          <RouterLink to="/" />
        </AppShellBrand>
      }
      // On a phone the tab bar is the navigation, so the drawer keeps only the account and host footer.
      nav={
        wide ? (
          <SideNav aria-label="Main">
            {items.map((item) => (
              <SideNavItem key={item.to} asChild icon={<item.Icon />} label={item.label} current={isNavCurrent(pathname, item)} {...countFor(item.to)}>
                <RouterLink to={item.to} />
              </SideNavItem>
            ))}
          </SideNav>
        ) : undefined
      }
      footer={
        <>
          {can ? <HostHealth warnings={needsYou.hostWarnings} /> : null}
        <AccountMenu name={me?.displayName ?? email} detail={`${email} · ${me?.role ?? ''}`}>
          <MenuItem
            onSelect={() => {
              void navigate('/settings/people');
            }}
          >
            Account
          </MenuItem>
          <ThemeSwitch label="Theme" />
          <MenuSeparator />
          <MenuItem
            tone="danger"
            onSelect={() => {
              void signOut();
            }}
          >
            Sign out
          </MenuItem>
        </AccountMenu>
        </>
      }
    >
      <div className="shp-topline">
        <span className="shp-topline__who" title={email}>
          <span className="shp-visually-hidden">Signed in as </span>
          {email}
        </span>
        <ThemeToggle />
      </div>
      {children ?? <Outlet />}
      {wide ? null : (
        <>
          {/* The bar is fixed to the screen's foot; this keeps the page's last line clear of it. */}
          <div className="shp-tabbar-clear" aria-hidden="true" />
          <TabBar aria-label="Primary" className="shp-tabbar">
            {items.map((item) => (
              <TabBar.Item
                key={item.to}
                href={item.to}
                icon={<item.Icon />}
                label={item.label}
                current={isNavCurrent(pathname, item)}
                {...countFor(item.to)}
                // A tab is a plain link; take the click so the page does not reload.
                onClick={(event) => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault();
                  void navigate(item.to);
                }}
              />
            ))}
          </TabBar>
        </>
      )}
    </AppShell>
  );
}
