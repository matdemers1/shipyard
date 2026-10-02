import './entry.css';
import { ThemeSwitch } from '@d3cloud/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ShipyardMark } from '../brand/ShipyardMark';
import { fetchBuildLabel } from './build';
import { DeployIllustration } from './DeployIllustration';

/**
 * SHP-T-9.2: every screen somebody sees before they are signed in — Sign in, first-run Setup, an
 * invite, and the console's own loading and not-answering states — in the D3 Cloud front door shared
 * with Bindery and Postroom.
 *
 * Split: the left half says what Shipyard is and names three claims a person can check in the
 * deploy record; the right half is the form. Below 1024px the story is dropped rather than squeezed,
 * and the mark and name sit above the form instead — on a phone the form is the whole job.
 *
 * The aside is a landmark with its own label and an h2, so each screen keeps exactly one h1 — the
 * form's — and the form is the page's <main>. The sign-in pages have no app shell, so the theme
 * choice lives here, under the form, at every width (SHP-REQ-055).
 */
export function EntryShell({
  children,
  wide = false,
}: {
  children: ReactNode;
  /** Setup and an invite: about 28rem rather than 24. */
  wide?: boolean;
}) {
  return (
    <div className="shp-entry">
      <StoryPanel />
      <main className="shp-entry__main">
        <div className={wide ? 'shp-entry__column shp-entry__column--wide' : 'shp-entry__column'}>
          <div className="shp-entry__brand shp-entry__brand--compact">
            <ShipyardMark size={28} decorative /> Shipyard
          </div>
          {children}
          <div className="shp-entry__theme">
            <ThemeSwitch label="Theme" size="sm" />
          </div>
        </div>
      </main>
    </div>
  );
}

export const ENTRY_HEADLINE = 'One button to deploy —';
export const ENTRY_HEADLINE_ACCENT = 'and one to take it back.';
export const ENTRY_PROMISE =
  "Pick an app and a green commit. Shipyard runs the app's backup, swaps the image by digest, watches it soak, and puts the old image back if it fails.";
export const ENTRY_CLAIMS: readonly { title: string; detail: string }[] = [
  { title: 'Nothing ships that CI did not pass.', detail: 'The agent on the host checks it again itself.' },
  { title: 'The backup runs before the migration.', detail: 'If it fails, nothing is swapped.' },
  { title: 'A failed soak rolls itself back.', detail: 'To the old digests — unless it carries a contract migration.' },
];

/**
 * The arrival animation plays once per page load. The loading state, Sign in and Setup each mount
 * their own shell; after the first has played, the rest arrive already settled.
 */
let arrived = false;
const ARRIVAL_MS = 1600;

function StoryPanel() {
  const build = useBuild();
  const [settled] = useState(() => arrived);
  useEffect(() => {
    if (arrived) return;
    const timer = window.setTimeout(() => {
      arrived = true;
    }, ARRIVAL_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, []);

  return (
    <aside aria-label="About Shipyard" className="shp-entry__story" {...(settled ? { 'data-settled': '' } : {})}>
      <div className="shp-entry__brand">
        <ShipyardMark size={28} decorative /> Shipyard
      </div>

      <DeployIllustration className="shp-entry__art" />

      <div className="shp-entry__pitch">
        <h2 className="shp-entry__headline">
          {ENTRY_HEADLINE} <span className="shp-entry__headline-accent">{ENTRY_HEADLINE_ACCENT}</span>
        </h2>
        <p className="shp-entry__promise">{ENTRY_PROMISE}</p>
        <ul className="shp-entry__claims">
          {ENTRY_CLAIMS.map((c) => (
            <Claim key={c.title} title={c.title}>
              {c.detail}
            </Claim>
          ))}
        </ul>
      </div>

      <footer className="shp-entry__foot">
        {build === null ? null : <span className="shp-entry__build">{build}</span>}
        <span>self-hosted</span>
      </footer>
    </aside>
  );
}

function Claim({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="shp-entry__claim">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false" className="shp-entry__tick">
        <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>
        <span className="shp-entry__claim-title">{title}</span> {children}
      </span>
    </li>
  );
}

/** The running build's short revision, or null until (and unless) /api/health names a real one. */
function useBuild(): string | null {
  const [build, setBuild] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void fetchBuildLabel().then((label) => {
      if (live) setBuild(label);
    });
    return () => {
      live = false;
    };
  }, []);
  return build;
}

/**
 * The heading every entry form opens with: the screen's one h1 and a muted line under it.
 * `focusOnMount` moves focus to the heading so the step is announced, as AuthLayout's did; turn it
 * off when a field on the screen autofocuses instead.
 */
export function EntryHeading({
  title,
  children,
  focusOnMount = true,
}: {
  title: string;
  children?: ReactNode;
  focusOnMount?: boolean;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusOnMount) ref.current?.focus();
  }, [focusOnMount]);
  return (
    <header className="shp-entry__heading">
      <h1 ref={ref} tabIndex={-1} className="shp-entry__title">
        {title}
      </h1>
      {children === undefined ? null : <p className="shp-entry__lede">{children}</p>}
    </header>
  );
}

/**
 * Under a form, past a hairline: small muted lines saying where to go when this screen is not the
 * answer, or (`row`) the text buttons that change step.
 */
export function EntryNotes({ children, row = false }: { children: ReactNode; row?: boolean }) {
  return <div className={row ? 'shp-entry__notes shp-entry__notes--row' : 'shp-entry__notes'}>{children}</div>;
}
