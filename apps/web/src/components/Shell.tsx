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
import type { ReactNode } from 'react';
import { Link as RouterLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, useCan, useMe } from '../lib/auth';
import { NAV_ITEMS } from '../nav';

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

export function Shell({ children }: { children?: ReactNode }) {
  const me = useMe();
  const can = useCan();
  const { signOut } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  const items = NAV_ITEMS.filter((item) => !item.needsStateChange || can);
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
            <SideNavItem key={to} asChild icon={<Icon />} label={label} current={isCurrent(pathname, to)}>
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
