/**
 * The board's `?card=` deep link (an inbox row's target, or the card menu's
 * "Copy link"): an active card opens its panel, a trashed one says so, an
 * unknown one says it is gone. While a panel is open the URL carries its
 * card, whichever way it was opened, so the address bar is itself the link;
 * closing the panel takes the parameter away again.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { AitoPage } from '../../pages/AitoPage';
import { makeProject } from '../fixtures/aitoProject';
import { __resetBoardSync } from '../../hooks/useBoardSync';

const active = makeProject({ id: 41, description: 'Support GoPro', column: 'print' });
const trashed = makeProject({ id: 40, description: 'Old bracket', status: 'deleted' });

let lengthAtRender = 0;
const historyLengthAtRender = () => lengthAtRender;

function renderAt(url: string) {
  window.history.pushState({}, '', url);
  lengthAtRender = window.history.length;
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

  it('opens the panel on an active card, scrolls its column into view and keeps the parameter until the panel closes', async () => {
    const user = userEvent.setup();
    renderAt('/aito?card=41');

    const panel = await screen.findByRole('dialog');
    expect(panel).toHaveTextContent('Support GoPro');
    const column = document.querySelector('[data-column-id="print"]');
    expect(column).not.toBeNull();
    expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts).toContain(column);
    // The URL still names the card: a reload or a copied address bar lands here again.
    expect(window.location.search).toBe('?card=41');
    // A board refetch while the panel is up neither re-scrolls nor reopens.
    const scrolls = vi.mocked(Element.prototype.scrollIntoView).mock.calls.length;
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(window.location.search).not.toContain('card='));
    expect(vi.mocked(Element.prototype.scrollIntoView).mock.calls.length).toBe(scrolls);
  });

  it('writes the card into the URL when a card is opened from the board, and takes it out on close', async () => {
    const user = userEvent.setup();
    renderAt('/aito');

    await user.click(await screen.findByRole('button', { name: /Support GoPro/ }));
    await screen.findByRole('dialog');
    await waitFor(() => expect(window.location.search).toBe('?card=41'));
    // Mirrored, not navigated: Back leaves the board, it does not step through cards.
    expect(window.history.length).toBe(historyLengthAtRender());
    // The board's own open does not scroll a column into view — only a link does.
    expect(vi.mocked(Element.prototype.scrollIntoView)).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(window.location.search).toBe(''));
  });

  it('opens a done card behind the done view, so it is on screen when the panel closes', async () => {
    const done = makeProject({ id: 42, description: 'Finished bracket', column: 'done' });
    server.use(http.get('/api/v1/aito/', () => HttpResponse.json([active, done])));
    const user = userEvent.setup();
    renderAt('/aito?card=42');

    const panel = await screen.findByRole('dialog');
    expect(panel).toHaveTextContent('Finished bracket');
    expect(window.location.search).toBe('?card=42');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // The done archive is up: its toggle reads as the way back, and the card is listed.
    expect(screen.getByRole('button', { name: /back to board/i })).toBeInTheDocument();
    expect(screen.getByText('Finished bracket')).toBeInTheDocument();
    expect(within(document.body).queryByText('Support GoPro')).not.toBeInTheDocument();
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
    expect(window.location.search).toBe('?card=58');
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
