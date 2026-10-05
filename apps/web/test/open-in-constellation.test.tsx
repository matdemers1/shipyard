import { ThemeProvider } from '@d3cloud/ui';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { constellationLink, OpenInConstellation } from '../src/components/OpenInConstellation';

/** SHP-T-11.1: the link D3 Constellation opens, offered only where the app exists. */
describe('Open in D3 Constellation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names this host and Shipyard, so the app opens the same connection', () => {
    expect(constellationLink('app/bindery', 'shipyard.d3cloud.io')).toBe('d3constellation://shipyard.d3cloud.io/shipyard/app/bindery');
    expect(constellationLink('app/bindery/deploy/d-1', 'shipyard.d3cloud.io')).toBe('d3constellation://shipyard.d3cloud.io/shipyard/app/bindery/deploy/d-1');
  });

  it('is offered on an iPhone and not elsewhere', () => {
    const agent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X)');
    const { unmount } = render(<ThemeProvider><OpenInConstellation path="app/bindery" /></ThemeProvider>);
    expect(screen.getByRole('button', { name: 'Open in D3 Constellation' })).toBeTruthy();
    unmount();
    agent.mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    render(<ThemeProvider><OpenInConstellation path="app/bindery" /></ThemeProvider>);
    expect(screen.queryByRole('button', { name: 'Open in D3 Constellation' })).toBeNull();
  });
});
