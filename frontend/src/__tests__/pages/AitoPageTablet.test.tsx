import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { AitoPage } from '../../pages/AitoPage';
import { __resetBoardSync } from '../../hooks/useBoardSync';
import { makeProject } from '../fixtures/aitoProject';

const defaultMatchMedia = window.matchMedia;
const defaultWidth = window.innerWidth;

/** `max-width` / `min-width` answer from the width, `pointer: coarse` from the
 *  touch flag — enough to put the page on the phone, tablet or desktop board. */
function installViewport(width: number, coarse: boolean) {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => {
      const max = /max-width:\s*(\d+)px/.exec(query);
      const min = /min-width:\s*(\d+)px/.exec(query);
      const wantsCoarse = /pointer:\s*coarse/.test(query);
      const matches =
        (!max || width <= Number(max[1])) && (!min || width >= Number(min[1])) && (!wantsCoarse || coarse) && !!(max || min || wantsCoarse);
      return { ...defaultMatchMedia(query), matches, media: query };
    },
  });
}

// A quote sent months ago lands in the "quote out, no answer" follow-up bucket.
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

describe('AitoPage on a tablet', () => {
  it('touch 1180 px → tablet board, no desktop chrome, no drag', async () => {
    installViewport(1180, true);
    render(<AitoPage />);
    await screen.findByTestId('aito-tablet-board');
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(document.querySelector('[id^="DndDescribedBy"]')).toBeNull();
    expect(screen.queryByTestId('aito-mobile-header')).toBeNull();
    expect(await screen.findByRole('button', { name: 'New quote' })).toBeInTheDocument();
  });

  it('mouse 1180 px → desktop board unchanged', async () => {
    installViewport(1180, false);
    render(<AitoPage />);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByTestId('aito-tablet-board')).toBeNull();
    expect(document.querySelector('[id^="DndDescribedBy"]')).not.toBeNull();
  });

  it('touch 390 px → phone board', async () => {
    installViewport(390, true);
    render(<AitoPage />);
    await screen.findByTestId('aito-mobile-header');
    expect(screen.queryByTestId('aito-tablet-board')).toBeNull();
  });

  it('the compact follow-up badge filters the tablet board', async () => {
    const user = userEvent.setup();
    installViewport(1180, true);
    render(<AitoPage />);
    await screen.findByRole('button', { name: 'New quote' });
    await user.click(await screen.findByTestId('aito-followup-quoteOut'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'New quote' })).toBeNull());
  });
});
