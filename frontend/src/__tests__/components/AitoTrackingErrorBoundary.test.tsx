import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { render as rtlRender, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '../../i18n';
import { TrackingErrorBoundary } from '../../components/aito/trackingShell';

// T-027: the four /t and /track routes must never fall through to
// App.tsx's app-wide "UI Crash" screen (raw stack trace, monospace red
// text) — the client who followed a link printed on their quote gets the
// tracking card's own branded error state instead. `TrackingErrorBoundary`
// wraps those routes in App.tsx; this file exercises the boundary itself,
// not the routing (the fe-router golden pins the route wiring).

// French is the tracking pages' effective default (trackingDefaultLanguage
// falls back to it, not English) and the copy the "Réessayer" assertions
// below key off — same convention as AitoTrackPage.test.tsx / AitoTrackEntryPage.test.tsx.
beforeAll(() => i18n.changeLanguage('fr'));
afterAll(() => i18n.changeLanguage('en'));
afterEach(() => {
  cleanup();
});

/** A child that throws `error` for as long as `box.throwing` is true, and
 *  renders normal content once it is set to false — flipped by the *test*,
 *  never by the component itself. React 18/19 recovers from a render error
 *  by synchronously re-rendering the whole tree once before giving up and
 *  calling the boundary's lifecycle methods (the "instead synchronously
 *  rendering the entire root" note in its own warning); a component that
 *  decides "have I thrown yet?" from its own render would stop throwing on
 *  that internal retry and the boundary would never see an error at all.
 *  Reading a plain object instead keeps every render within one mount
 *  consistent, so both of React's attempts throw and the boundary catches
 *  for real; only a deliberate flip between renders (e.g. after Retry) is
 *  allowed to change the outcome. */
function makeBomb(error: Error) {
  const box = { throwing: true };
  function Bomb() {
    if (box.throwing) {
      throw error;
    }
    return <p>recovered content</p>;
  }
  return { Bomb, box };
}

/** React 19 reports an error an error boundary caught to the window as
 *  well as to `console.error` (`window.reportError`, the default
 *  `onUncaughtError`/`onCaughtError` root behaviour); jsdom turns that into
 *  an "Uncaught Exception" that fails the test file even though the
 *  boundary itself catches the error and renders correctly. Swallow the
 *  window-level report for the duration of a throwing render; `console.error`
 *  is muted separately by each test (and one test asserts on it). */
function renderThrowing(ui: ReactElement) {
  const onWindowError = (e: ErrorEvent) => e.preventDefault();
  window.addEventListener('error', onWindowError);
  try {
    return rtlRender(ui);
  } finally {
    window.removeEventListener('error', onWindowError);
  }
}

/** Replaces `window.location` with a reload spy for the duration of a
 *  test — copied from GitHubRestoreModal.test.tsx's `stubReload`. */
function stubReload() {
  const original = window.location;
  const reload = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...original, reload },
  });
  return {
    reload,
    restore: () => Object.defineProperty(window, 'location', { configurable: true, value: original }),
  };
}

describe('TrackingErrorBoundary', () => {
  it('renders its children untouched while nothing throws', () => {
    rtlRender(
      <TrackingErrorBoundary>
        <p>hello from the tracking page</p>
      </TrackingErrorBoundary>,
    );
    expect(screen.getByText('hello from the tracking page')).toBeInTheDocument();
    expect(screen.queryByTestId('track-crash')).not.toBeInTheDocument();
  });

  it('catches a render crash and shows the branded card instead of a stack trace', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { Bomb } = makeBomb(new Error('boom, a genuinely unrelated failure'));
    try {
      renderThrowing(
        <TrackingErrorBoundary>
          <Bomb />
        </TrackingErrorBoundary>,
      );
      const card = screen.getByTestId('track-crash');
      expect(card).toHaveTextContent('Erreur de chargement');
      expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument();
      // Never the developer crash screen's contract: no raw error message,
      // no stack, no "UI Crash" heading, anywhere in the boundary's output.
      expect(card).not.toHaveTextContent('boom, a genuinely unrelated failure');
      expect(card).not.toHaveTextContent('UI Crash');
      expect(card.querySelector('pre')).toBeNull();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('logs the crash the same way the app-wide boundary does', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { Bomb } = makeBomb(new Error('logged failure'));
    try {
      renderThrowing(
        <TrackingErrorBoundary>
          <Bomb />
        </TrackingErrorBoundary>,
      );
      const calls = consoleError.mock.calls.map((c) => c.join(' '));
      expect(calls.some((c) => c.includes('Tracking page crash:') && c.includes('logged failure'))).toBe(true);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('retrying a non-chunk crash resets the boundary and re-renders the (now healthy) children', async () => {
    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { Bomb, box } = makeBomb(new Error('a transient failure, not a chunk load'));
    try {
      renderThrowing(
        <TrackingErrorBoundary>
          <Bomb />
        </TrackingErrorBoundary>,
      );
      expect(screen.getByTestId('track-crash')).toBeInTheDocument();
      // The next mount must succeed, or clicking Retry would just crash the
      // boundary again — flip it before the click, same as the underlying
      // chunk having actually loaded by the time the client retries.
      box.throwing = false;
      await user.click(screen.getByRole('button', { name: 'Réessayer' }));
      expect(screen.queryByTestId('track-crash')).not.toBeInTheDocument();
      expect(screen.getByText('recovered content')).toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('retrying a chunk-load-shaped error forces a full reload instead of just resetting', async () => {
    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const loc = stubReload();
    // Mirrors the shape Vite's dynamic import() rejection carries in
    // Chrome/most browsers, which is what `lazyWithReload` (App.tsx)
    // rethrows on a second failed chunk fetch.
    const { Bomb, box } = makeBomb(new Error('Failed to fetch dynamically imported module: /assets/AitoTrackPage-abc123.js'));
    try {
      renderThrowing(
        <TrackingErrorBoundary>
          <Bomb />
        </TrackingErrorBoundary>,
      );
      expect(screen.getByTestId('track-crash')).toBeInTheDocument();
      // In production a reload replaces the whole page, so nothing renders
      // again after it; here `window.location.reload` is a spy, and the
      // boundary's own state reset re-renders the still-throwing child —
      // let it succeed so the click itself resolves cleanly.
      box.throwing = false;
      await user.click(screen.getByRole('button', { name: 'Réessayer' }));
      expect(loc.reload).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
      loc.restore();
    }
  });

  it('also recognises the ChunkLoadError name (older bundlers / Firefox), not just the message wording', async () => {
    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const loc = stubReload();
    const error = new Error('generic network failure');
    error.name = 'ChunkLoadError';
    const { Bomb, box } = makeBomb(error);
    try {
      renderThrowing(
        <TrackingErrorBoundary>
          <Bomb />
        </TrackingErrorBoundary>,
      );
      expect(screen.getByTestId('track-crash')).toBeInTheDocument();
      box.throwing = false;
      await user.click(screen.getByRole('button', { name: 'Réessayer' }));
      expect(loc.reload).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
      loc.restore();
    }
  });
});
