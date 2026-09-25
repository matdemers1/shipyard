import { Bot, CalendarClock, History, House, KeyRound, Server, SlidersHorizontal, Users, type LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  Icon: LucideIcon;
  /** Shown only to roles that may change state (deployer, operator, admin) — SHP-REQ-105. */
  needsStateChange: boolean;
  /** Shown only to an admin (Settings, SHP-REQ-110). */
  needsAdmin?: boolean;
}

/** The primary navigation, in order. Account and sign-out live in the account menu instead. */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Home', Icon: House, needsStateChange: false },
  { to: '/timeline', label: 'Timeline', Icon: History, needsStateChange: false },
  { to: '/schedules', label: 'Schedules', Icon: CalendarClock, needsStateChange: false },
  { to: '/system', label: 'System', Icon: Server, needsStateChange: true },
  { to: '/agent', label: 'Agent', Icon: Bot, needsStateChange: true },
  { to: '/tokens', label: 'API tokens', Icon: KeyRound, needsStateChange: true },
  { to: '/users', label: 'Users', Icon: Users, needsStateChange: true },
  { to: '/settings', label: 'Settings', Icon: SlidersHorizontal, needsStateChange: true, needsAdmin: true },
];
