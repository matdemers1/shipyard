import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

/**
 * jsdom has no layout, no media queries and no observers. The shell asks `(min-width: 1024px)` to
 * choose sidebar or drawer, and the theme asks `prefers-color-scheme`; `desktop` flips the first so
 * a test can render the phone layout.
 */
export const viewport = { desktop: true };

function matchMedia(query: string): MediaQueryList {
  const matches = query.includes('min-width') ? viewport.desktop : false;
  return {
    matches,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  };
}

class ResizeObserverStub {
  observe(): void {
    /* no layout in jsdom */
  }
  unobserve(): void {
    /* no layout in jsdom */
  }
  disconnect(): void {
    /* no layout in jsdom */
  }
}

// The whole workspace's tests run at once in CI and in `pnpm test`; under that load jsdom renders
// slowly enough that the default 1 s wait for `findBy…` times out on a correct screen.
configure({ asyncUtilTimeout: 5000 });

Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: matchMedia });
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  viewport.desktop = true;
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});
