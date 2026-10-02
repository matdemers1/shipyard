import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { ThemeProvider } from '@d3cloud/ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SHIPYARD_STAR, ShipyardMark } from '../src/brand/ShipyardMark';
import { buildLabel } from '../src/entry/build';
import { DEPLOY_STEPS } from '../src/entry/DeployIllustration';
import {
  ENTRY_CLAIMS,
  ENTRY_HEADLINE,
  ENTRY_HEADLINE_ACCENT,
  ENTRY_PROMISE,
  EntryHeading,
  EntryNotes,
  EntryShell,
} from '../src/entry/EntryShell';
import { D3AUTH_LABEL, SignInWithD3Auth } from '../src/entry/SignInWithD3Auth';
import { mockFetch } from './fetch';

/**
 * SHP-T-9.1 (the family mark) and SHP-T-9.2 (the front door): Sign in, Setup, an invite and the
 * console's loading and not-answering states in one split shell, after Bindery's and Postroom's.
 */

const WEB = join(__dirname, '..');
const read = (path: string): string => readFileSync(join(WEB, path), 'utf8');

function renderShell(wide = false) {
  mockFetch({});
  return render(
    <ThemeProvider storageKey="test.theme" defaultPreference="system">
      <EntryShell wide={wide}>
        <EntryHeading title="Sign in">Deploys for this host&apos;s compose stacks.</EntryHeading>
        <form aria-label="The form" />
      </EntryShell>
    </ThemeProvider>,
  );
}

describe('the Shipyard mark', () => {
  it('stands alone as an image named Shipyard', () => {
    render(<ShipyardMark />);
    const mark = screen.getByRole('img', { name: 'Shipyard' });
    expect(mark.getAttribute('viewBox')).toBe('0 0 64 64');
    expect(mark.getAttribute('fill')).toBe('none');
  });

  it('is hidden from a screen reader when the name is written beside it', () => {
    const html = renderToStaticMarkup(<ShipyardMark decorative />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="img"');
  });

  it("draws the site's Lift-off: ring, arc and joints in currentColor, one lit star in the accent", () => {
    const icon = renderToStaticMarkup(<ShipyardMark size={28} />);
    expect(icon).toContain('<circle cx="32" cy="32" r="26" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"></circle>');
    expect(icon).toContain('<path d="M18 47 Q21 27 45 18"');
    expect(icon).toContain('<circle cx="18" cy="47" r="3.4" fill="currentColor"></circle>');
    expect(icon).toContain('<circle cx="25.5" cy="29" r="3.4" fill="currentColor"></circle>');
    expect(icon).toContain('<circle cx="45" cy="18" r="5.5" style="fill:#5EEAD4"></circle>');
    expect(SHIPYARD_STAR).toBe('#5EEAD4');
    // Finer lines at display size, as on d3cloud.io.
    const display = renderToStaticMarkup(<ShipyardMark size={72} />);
    expect(display).toContain('stroke-width="2.2"');
    expect(display).toContain('r="2.6" fill="currentColor"');
    expect(display).toContain('r="4.4" style="fill:#5EEAD4"');
  });

  it('replaces the placeholder in the shell brand, with its ink on the text colour', () => {
    const shell = read('src/components/Shell.tsx');
    expect(shell).toContain('mark={<ShipyardMark decorative className="shp-brand-mark" />}');
    expect(shell).not.toMatch(/\bShip\b(?!yard)/);
    expect(read('src/styles.css')).toMatch(/\.shp-brand-mark \{\s*color: var\(--color-fg\);/);
  });

  it('is the favicon, with fixed ink per colour scheme and the star in the accent', () => {
    expect(read('index.html')).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
    const svg = read('public/favicon.svg');
    expect(svg).toContain('viewBox="0 0 64 64"');
    expect(svg).toContain('<path d="M18 47 Q21 27 45 18" />');
    expect(svg).toContain('.ink { stroke: #101117; }');
    expect(svg).toMatch(/@media \(prefers-color-scheme: dark\) \{\s*\.ink \{ stroke: #f0f2f7; \}/);
    expect(svg).toContain('.star { fill: #5EEAD4; }');
    expect(svg).toContain('stroke-width="3.5"');
  });
});

describe('EntryShell', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is a story aside and a main, with the form in the main', () => {
    const { container } = renderShell();
    const story = screen.getByRole('complementary', { name: 'About Shipyard' });
    const main = screen.getByRole('main');
    expect(container.querySelectorAll('aside')).toHaveLength(1);
    expect(container.querySelectorAll('main')).toHaveLength(1);
    expect(within(main).getByRole('form', { name: 'The form' })).toBeInTheDocument();
    expect(within(story).queryByRole('form')).not.toBeInTheDocument();
  });

  it('keeps exactly one h1 — the form’s — and gives the story an h2 headline with its accent half', () => {
    const { container } = renderShell();
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByText("Deploys for this host's compose stacks.")).toHaveClass('shp-entry__lede');
    const h2 = screen.getByRole('heading', { level: 2 });
    expect(h2.textContent).toBe(`${ENTRY_HEADLINE} ${ENTRY_HEADLINE_ACCENT}`);
    expect(within(h2).getByText(ENTRY_HEADLINE_ACCENT)).toHaveClass('shp-entry__headline-accent');
    expect(ENTRY_HEADLINE).toBe('One button to deploy —');
    expect(ENTRY_HEADLINE_ACCENT).toBe('and one to take it back.');
  });

  it('makes the promise and three checkable claims, each with a tick', () => {
    renderShell();
    const story = screen.getByRole('complementary', { name: 'About Shipyard' });
    expect(within(story).getByText(ENTRY_PROMISE)).toBeInTheDocument();
    const claims = within(story).getAllByRole('listitem');
    expect(claims).toHaveLength(3);
    for (const [i, claim] of claims.entries()) {
      expect(claim.querySelector('.shp-entry__tick')).not.toBeNull();
      expect(claim).toHaveTextContent(`${ENTRY_CLAIMS[i]?.title ?? ''} ${ENTRY_CLAIMS[i]?.detail ?? ''}`);
    }
    expect(ENTRY_CLAIMS.map((c) => c.title)).toEqual([
      'Nothing ships that CI did not pass.',
      'The backup runs before the migration.',
      'A failed soak rolls itself back.',
    ]);
    // Words a person can check in a deploy record, not the words every login page uses.
    for (const text of [ENTRY_PROMISE, ...ENTRY_CLAIMS.flatMap((c) => [c.title, c.detail])]) {
      expect(text).not.toMatch(/\b(secure|private|safe)\b/i);
    }
  });

  it('carries the mark and name twice, decorative beside the word: in the story, and above the form', () => {
    const { container } = renderShell();
    expect(container.querySelectorAll('.shp-entry__brand')).toHaveLength(2);
    expect(container.querySelectorAll('.shp-entry__brand--compact')).toHaveLength(1);
    const marks = container.querySelectorAll('.shp-entry__brand > svg');
    expect(marks).toHaveLength(2);
    for (const mark of marks) {
      expect(mark).toHaveAttribute('aria-hidden', 'true');
      expect(mark).toHaveAttribute('width', '28');
    }
    expect(screen.queryByRole('img', { name: 'Shipyard' })).not.toBeInTheDocument();
  });

  it('draws the deploy steps in the order the engine runs them, decorative and tokens-only', () => {
    const { container } = renderShell();
    expect(DEPLOY_STEPS).toEqual(['backup', 'migrate', 'pull', 'swap', 'check', 'soak']);
    const art = container.querySelector('svg.shp-entry__art');
    expect(art).not.toBeNull();
    expect(art).toHaveAttribute('aria-hidden', 'true');
    expect(art?.querySelectorAll('.shp-entry-art__step')).toHaveLength(6);
    expect(art?.outerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it('ends the story with a footer that says self-hosted, and offers the theme under the form', () => {
    const { container } = renderShell();
    expect(container.querySelector('.shp-entry__foot')?.textContent).toBe('self-hosted');
    const main = screen.getByRole('main');
    expect(within(main).getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
  });

  it('has a wider column for Setup and an invite', () => {
    expect(renderShell().container.querySelector('.shp-entry__column')).not.toHaveClass('shp-entry__column--wide');
    expect(renderShell(true).container.querySelector('.shp-entry__column--wide')).not.toBeNull();
  });

  it('EntryHeading leaves out the lede when there is none; EntryNotes has a row form', () => {
    expect(renderToStaticMarkup(<EntryHeading title="Shipyard" />)).toBe(
      '<header class="shp-entry__heading"><h1 tabindex="-1" class="shp-entry__title">Shipyard</h1></header>',
    );
    expect(renderToStaticMarkup(<EntryNotes row>x</EntryNotes>)).toBe('<div class="shp-entry__notes shp-entry__notes--row">x</div>');
  });
});

describe('the build label', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('shows the first seven characters of a commit', () => {
    expect(buildLabel('30593dd333296f7f9ef5613ea1c211e9f32d310b')).toBe('30593dd');
    expect(buildLabel('ABCDEF0')).toBe('abcdef0');
  });

  it('hides dev, unknown, a harness name, empty and missing values', () => {
    for (const value of ['dev', 'unknown', 'console-e2e', '', '  ', 'abc', undefined, null, 42, {}]) expect(buildLabel(value)).toBeNull();
  });

  it('asks the public /api/health once per page load and reads its version', async () => {
    const calls = mockFetch({
      'GET /api/health': { status: 200, body: { status: 'ok', schemaRevision: '20260925_x', version: '0123456789abcdef0123456789abcdef01234567' } },
    });
    vi.resetModules();
    const { fetchBuildLabel } = await import('../src/entry/build');
    expect(await fetchBuildLabel()).toBe('0123456');
    expect(await fetchBuildLabel()).toBe('0123456');
    expect(calls.filter((c) => c.path === '/api/health')).toHaveLength(1);
  });

  it('is null when the answer is not JSON, or there is no answer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.reject(new SyntaxError('not json')) }));
    vi.resetModules();
    expect(await (await import('../src/entry/build')).fetchBuildLabel()).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    vi.resetModules();
    expect(await (await import('../src/entry/build')).fetchBuildLabel()).toBeNull();
  });
});

describe('Sign in with D3 Auth', () => {
  it('is a real navigation link under an "or" divider, with a key glyph', () => {
    const html = renderToStaticMarkup(<SignInWithD3Auth offered />);
    expect(html).toContain('<div class="shp-entry-or" aria-hidden="true"><span></span>or<span></span></div>');
    expect(html).toMatch(new RegExp(`<a class="shp-entry-sso" href="/api/auth/oidc/start"><svg [^>]*aria-hidden="true"[^>]*>.*</svg>${D3AUTH_LABEL}</a>`));
    expect(D3AUTH_LABEL).toBe('Sign in with D3 Auth');
  });

  it('is nothing at all when the server does not offer it', () => {
    expect(renderToStaticMarkup(<SignInWithD3Auth offered={false} />)).toBe('');
  });
});

describe('entry.css', () => {
  const css = read('src/entry/entry.css');

  it('splits from lg (1024px) up, with the story on the sunken ground behind a hairline', () => {
    const lg = css.slice(css.indexOf('@media (min-width: 64rem)'));
    expect(lg).toMatch(/\.shp-entry \{\s*grid-template-columns: minmax\(0, 1\.05fr\) minmax\(0, 1fr\);/);
    expect(lg).toMatch(/\.shp-entry__story \{[^}]*display: flex;[^}]*border-right: var\(--border-width\) solid var\(--color-border\);[^}]*background: var\(--color-bg-sunken\);/);
    expect(lg).toMatch(/\.shp-entry__brand--compact \{\s*display: none;/);
    // Below it the story is dropped, not squeezed.
    expect(css).toMatch(/^ {2}\.shp-entry__story \{\s*display: none;\s*\}/m);
  });

  it('sizes the form column like Bindery’s and Postroom’s', () => {
    expect(css).toMatch(/\.shp-entry__column \{[^}]*max-width: 384px;/);
    expect(css).toMatch(/\.shp-entry__column--wide \{\s*max-width: 448px;/);
  });

  it('plays the arrival once, and not at all under prefers-reduced-motion', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('.shp-entry-art__step');
    expect(reduced).toContain('.shp-entry-art__back');
    expect(reduced).toMatch(/\{\s*animation: none;\s*\}/);
    expect(css).toContain('.shp-entry__story[data-settled] .shp-entry-art__step');
    expect(css).not.toMatch(/animation:[^;]*\b(forwards|both|infinite)\b/);
  });

  it('uses tokens only: no raw colour, no shadow, and the display size says why', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/box-shadow|drop-shadow/);
    expect(css).toMatch(/d3-allow: [^\n]*display headline[\s\S]{0,600}font-size: 40px;/);
  });
});

describe('the screens use the shell, and AuthLayout is gone from them', () => {
  it('Sign in, Setup, an invite, and the loading and not-answering states', () => {
    for (const file of ['src/screens/SignIn.tsx', 'src/screens/Setup.tsx', 'src/screens/AcceptInvite.tsx', 'src/routes.tsx']) {
      const src = read(file);
      expect(src, file).not.toContain('AuthLayout');
      expect(src, file).toMatch(/<EntryShell( wide)?>/);
    }
    expect(read('src/screens/Setup.tsx')).toContain('<EntryShell wide>');
    expect(read('src/screens/AcceptInvite.tsx')).toContain('<EntryShell wide>');
  });
});
