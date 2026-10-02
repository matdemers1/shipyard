import { OIDC_START_PATH } from '../lib/api';

/**
 * SHP-T-9.2 (SHP-REQ-001): the second way in, below the password form, after Bindery's and
 * Postroom's front doors.
 *
 * Shown only when the server's `/api/auth/methods` says the D3 Auth client exists; when it does not,
 * or the methods call fails, there is nothing at all — the password form never depends on D3 Auth.
 * A real navigation, not a fetch: the server answers with a redirect the browser must follow.
 */
export const D3AUTH_LABEL = 'Sign in with D3 Auth';

export function SignInWithD3Auth({ offered }: { offered: boolean }) {
  if (!offered) return null;
  return (
    <div className="shp-entry-sso-group">
      <div className="shp-entry-or" aria-hidden="true">
        <span />
        or
        <span />
      </div>
      <a className="shp-entry-sso" href={OIDC_START_PATH}>
        <KeyGlyph />
        {D3AUTH_LABEL}
      </a>
    </div>
  );
}

function KeyGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="shp-entry-sso__glyph"
    >
      <circle cx="8" cy="12" r="4" />
      <path d="M12 12h9M18 12v3M15.5 12v2" />
    </svg>
  );
}
