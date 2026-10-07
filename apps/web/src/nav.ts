import { Activity, Layers, Settings, type LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  Icon: LucideIcon;
  /** Shown only to roles that may change state (deployer, operator, admin) — SHP-REQ-105. */
  needsStateChange: boolean;
  /** Shown only to an admin. */
  needsAdmin?: boolean;
  /** The nav item is current on this path or any path below it, as well as on `to` itself. */
  alsoCurrentOn?: readonly string[];
}

/**
 * The console's three destinations, in order (SHP-REQ-159, SHP-ADR-006): a sidebar on desktop and
 * a bottom tab bar on a phone. Everything the old ten-item nav held is a section of Settings or a
 * view of Activity. Settings is open to every signed-in role: each of its sections enforces its
 * own gate. Account and sign-out live in the account menu instead.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Apps', Icon: Layers, needsStateChange: false, alsoCurrentOn: ['/apps/', '/rollouts/'] },
  { to: '/activity', label: 'Activity', Icon: Activity, needsStateChange: false, alsoCurrentOn: ['/deploys/', '/builds/'] },
  { to: '/settings', label: 'Settings', Icon: Settings, needsStateChange: false },
];

/** Whether `pathname` belongs to `item`: `/` matches only itself and the paths it owns. */
export function isNavCurrent(pathname: string, item: NavItem): boolean {
  const owns = (prefix: string) => pathname === prefix.replace(/\/$/, '') || pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
  if (item.to === '/') return pathname === '/' || (item.alsoCurrentOn ?? []).some(owns);
  return owns(item.to) || (item.alsoCurrentOn ?? []).some(owns);
}
