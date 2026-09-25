import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { auth, setSessionGoneHandler, type Me, type RefusalError, type Role } from './api';

/**
 * Who is signed in, as the server says. The answer comes from `GET /api/auth/me` and nothing held
 * in the browser: the session cookie is HttpOnly, so there is no token here to go stale.
 */

export type AuthState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; me: Me }
  | { status: 'unreachable'; error: RefusalError };

export interface AuthContextValue {
  state: AuthState;
  /** Re-reads `/api/auth/me` — after the TOTP step, or after linking D3 Auth. */
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Roles that may change state. `operator` is the same as `deployer` (SHP-REQ-065). */
export const STATE_CHANGING_ROLES: readonly Role[] = ['admin', 'operator', 'deployer'];

export function canChangeState(role: Role | undefined): boolean {
  return role !== undefined && STATE_CHANGING_ROLES.includes(role);
}

export function AuthProvider({ children }: { children?: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  const refresh = useCallback(async () => {
    try {
      const me = await auth.me();
      setState(me === null ? { status: 'signed-out' } : { status: 'signed-in', me });
    } catch (error) {
      setState({ status: 'unreachable', error: error as RefusalError });
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await auth.logout();
    } finally {
      // Signed out locally whatever the server said: a 401 here means the session had already gone.
      setState({ status: 'signed-out' });
    }
  }, []);

  useEffect(() => {
    // Any session-bearing call answered 401: the session ended (expired, revoked, signed out elsewhere).
    setSessionGoneHandler(() => {
      setState({ status: 'signed-out' });
    });
    void refresh();
    return () => {
      setSessionGoneHandler(null);
    };
  }, [refresh]);

  const value = useMemo(() => ({ state, refresh, signOut }), [state, refresh, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}

/** The signed-in user, or null. */
export function useMe(): Me | null {
  const { state } = useAuth();
  return state.status === 'signed-in' ? state.me : null;
}

/**
 * Whether the signed-in user may change state (SHP-REQ-105). A viewer may not, and every screen
 * hides its state-changing actions when this is false — hidden, not disabled.
 */
export function useCan(): boolean {
  return canChangeState(useMe()?.role);
}
