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
});
