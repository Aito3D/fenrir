/**
 * The board's `?card=` deep link (an inbox row's target): an active card opens
 * its panel, a trashed one says so, an unknown one says it is gone — and in
 * every case the parameter leaves the URL so a refresh does not repeat it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { AitoPage } from '../../pages/AitoPage';
import { makeProject } from '../fixtures/aitoProject';
import { __resetBoardSync } from '../../hooks/useBoardSync';

const active = makeProject({ id: 41, description: 'Support GoPro', column: 'print' });
const trashed = makeProject({ id: 40, description: 'Old bracket', status: 'deleted' });

function renderAt(url: string) {
  window.history.pushState({}, '', url);
  render(<AitoPage />);
}

describe('AitoPage ?card= deep link', () => {
  const original = window.location.href;

  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockReturnValue(null);
    Element.prototype.scrollIntoView = vi.fn();
    __resetBoardSync();
    server.use(
      http.get('/api/v1/aito/', () => HttpResponse.json([active])),
      http.get('/api/v1/aito/trash', () => HttpResponse.json([trashed])),
    );
  });

  afterEach(() => {
    window.history.replaceState({}, '', original);
    vi.mocked(localStorage.getItem).mockReset();
  });

  it('opens the panel on an active card, scrolls its column into view and strips the parameter', async () => {
    renderAt('/aito?card=41');

    const panel = await screen.findByRole('dialog');
    expect(panel).toHaveTextContent('Support GoPro');
    await waitFor(() => expect(window.location.search).not.toContain('card='));
    const column = document.querySelector('[data-column-id="print"]');
    expect(column).not.toBeNull();
    expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts).toContain(column);
  });

  it('toasts instead of opening a card that is in the trash', async () => {
    renderAt('/aito?card=40');

    expect(await screen.findByText('This card is in the trash')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(window.location.search).not.toContain('card=');
  });

  it('toasts that a card in neither list no longer exists', async () => {
    renderAt('/aito?card=999');

    expect(await screen.findByText('This card no longer exists')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(window.location.search).not.toContain('card=');
  });

  it('refetches a board that does not hold the card yet and opens it from the fresh data', async () => {
    // The link names a card created a moment ago by someone else: the first
    // board answer predates it, the refetch has it.
    const fresh = makeProject({ id: 58, description: 'Brand new card', column: 'print' });
    let boardCalls = 0;
    server.use(
      http.get('/api/v1/aito/', () => {
        boardCalls += 1;
        return HttpResponse.json(boardCalls === 1 ? [active] : [active, fresh]);
      }),
    );
    renderAt('/aito?card=58');

    const panel = await screen.findByRole('dialog');
    expect(panel).toHaveTextContent('Brand new card');
    expect(boardCalls).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('This card no longer exists')).not.toBeInTheDocument();
    await waitFor(() => expect(window.location.search).not.toContain('card='));
  });

  it('says the lookup failed, not that the card is gone, when the trash cannot be read', async () => {
    server.use(http.get('/api/v1/aito/trash', () => HttpResponse.json({ detail: 'boom' }, { status: 500 })));
    renderAt('/aito?card=999');

    expect(await screen.findByText("This card couldn't be looked up")).toBeInTheDocument();
    expect(screen.queryByText('This card no longer exists')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(window.location.search).not.toContain('card=');
  });
});
