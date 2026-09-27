import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { AitoPage } from '../../pages/AitoPage';
import { __resetBoardSync } from '../../hooks/useBoardSync';
import { makeProject } from '../fixtures/aitoProject';

const defaultMatchMedia = window.matchMedia;
const defaultWidth = window.innerWidth;

/** A live viewport: `max-width` queries answer from the current width, and a
 *  `resize()` notifies every subscribed MediaQueryList, the way a real window
 *  does — useMediaQuery listens for exactly that change event. */
let width = 1280;
const listeners = new Set<() => void>();
function installViewport(initial: number) {
  width = initial;
  listeners.clear();
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => {
      const max = /max-width:\s*(\d+)px/.exec(query);
      const mql = {
        ...defaultMatchMedia(query),
        get matches() {
          return max ? width <= Number(max[1]) : false;
        },
        addEventListener: (_type: string, cb: (event: unknown) => void) => {
          listeners.add(() => cb(mql));
        },
        removeEventListener: () => {},
      };
      return mql;
    },
  });
}
function resize(next: number) {
  width = next;
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: next });
  act(() => listeners.forEach((notify) => notify()));
}

// A quote sent 30 days ago lands in the "quote out, no answer" follow-up bucket.
const stale = makeProject({
  id: 1, column: 'waiting', quote_status: 'sent', description: 'Old quote',
  created_at: '2026-01-01T10:00:00Z', quote_sent_at: '2026-01-02T10:00:00Z',
});
const fresh = makeProject({ id: 2, column: 'devis', description: 'New quote', created_at: new Date().toISOString() });

beforeEach(() => {
  __resetBoardSync();
  sessionStorage.clear();
  server.use(http.get('/api/v1/aito/', () => HttpResponse.json([stale, fresh])));
});
afterEach(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: defaultMatchMedia });
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: defaultWidth });
});

describe('AitoPage on a phone', () => {
  it('renders the mobile board instead of the desktop chrome', async () => {
    installViewport(390);
    render(<AitoPage />);
    await screen.findByTestId('aito-mobile-header');
    expect(screen.getByTestId('aito-mobile-pager')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.queryByRole('button', { name: /Show done/ })).toBeNull();
    expect(document.querySelector('[id^="DndDescribedBy"]')).toBeNull();
    expect(await screen.findByRole('button', { name: 'New quote' })).toBeInTheDocument();
  });

  it('keeps the desktop board at 1280 px', async () => {
    installViewport(1280);
    render(<AitoPage />);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByTestId('aito-mobile-header')).toBeNull();
    expect(document.querySelector('[id^="DndDescribedBy"]')).not.toBeNull();
  });

  it('opens the done view from the ⋯ menu and comes back', async () => {
    const user = userEvent.setup();
    installViewport(390);
    render(<AitoPage />);
    await user.click(await screen.findByRole('button', { name: 'More options' }));
    await user.click(screen.getByRole('menuitem', { name: /Show done/ }));
    await waitFor(() => expect(screen.queryByTestId('aito-mobile-header')).toBeNull());
    // The done view's own toggle, which reads "Back to board" while active.
    await user.click(await screen.findByRole('button', { name: 'Back to board' }));
    await screen.findByTestId('aito-mobile-header');
  });

  it('ignores a desktop follow-up filter on a phone, and restores it on desktop', async () => {
    const user = userEvent.setup();
    installViewport(1280);
    render(<AitoPage />);
    await user.click(await screen.findByTestId('aito-followup-quoteOut'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'New quote' })).toBeNull());
    resize(390);
    await screen.findByTestId('aito-mobile-header');
    expect(await screen.findByRole('button', { name: 'New quote' })).toBeInTheDocument();
    resize(1280);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'New quote' })).toBeNull());
  });
});
