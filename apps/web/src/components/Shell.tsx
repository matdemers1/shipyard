import {
  AccountMenu,
  AppShell,
  AppShellBrand,
  IconButton,
  MenuItem,
  MenuSeparator,
  SideNav,
  SideNavItem,
  ThemeSwitch,
  useTheme,
} from '@d3cloud/ui';
import { Moon, Ship, Sun } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link as RouterLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, useCan, useMe } from '../lib/auth';
import { NAV_ITEMS } from '../nav';
import { system } from '../lib/system';

/**
 * The signed-in frame: the design system's AppShell. At `lg` and up a sidebar; below it (every
 * phone, 375 px included) a top bar with a menu button, and the nav in a drawer — no horizontal
 * scroll. The nav shows only what the role may use (SHP-REQ-105).
 */

function isCurrent(pathname: string, to: string): boolean {
  return to === '/' ? pathname === '/' || pathname.startsWith('/apps/') : pathname.startsWith(to);
}

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

/**
 * What the System screen would warn about, counted for the nav, so a deployer sees it without
 * going there: deploys unsent to Foreman for over an hour (SHP-REQ-095), a GitHub token expiring
 * within 30 days or expired (SHP-REQ-106), and a stale agent. Read once per sign-in and every
 * five minutes; a failed read counts nothing rather than inventing a warning.
 */
function useSystemWarnings(enabled: boolean): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const read = () => {
      system
        .status()
        .then((s) => {
          if (!live) return;
          setCount((s.outbox.unsentOverHour > 0 ? 1 : 0) + (s.agent !== null && s.agent.patWarning !== 'none' ? 1 : 0) + (s.agent?.stale === true ? 1 : 0));
        })
        .catch(() => undefined);
    };
    read();
    const timer = setInterval(read, 5 * 60 * 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [enabled]);
  return count;
}

export function Shell({ children }: { children?: ReactNode }) {
  const me = useMe();
  const can = useCan();
  const { signOut } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  const isAdmin = me?.role === 'admin';
  const items = NAV_ITEMS.filter((item) => (!item.needsStateChange || can) && (item.needsAdmin !== true || isAdmin));
  const systemWarnings = useSystemWarnings(can);
  const email = me?.email ?? '';

  return (
    <AppShell
      storageKey="shipyard.nav"
      mainId="main"
      brand={
        <AppShellBrand asChild name="Shipyard" mark={<Ship aria-hidden />}>
          <RouterLink to="/" />
        </AppShellBrand>
      }
      nav={
        <SideNav aria-label="Main">
          {items.map(({ to, label, Icon }) => (
            <SideNavItem
              key={to}
              asChild
              icon={<Icon />}
              label={label}
              current={isCurrent(pathname, to)}
              // countLabel replaces the link's whole accessible name, so it must still say where it goes.
              {...(to === '/system' && systemWarnings > 0 ? { count: systemWarnings, countLabel: `${label}, ${String(systemWarnings)} needing attention` } : {})}
            >
              <RouterLink to={to} />
            </SideNavItem>
          ))}
        </SideNav>
      }
      footer={
        <AccountMenu name={me?.displayName ?? email} detail={`${email} · ${me?.role ?? ''}`}>
          <MenuItem
            onSelect={() => {
              void navigate('/account');
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
    </AppShell>
  );
}
