/**
 * Tests for the AitoPage component (DB-backed Kanban board).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, act, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { AitoPage } from '../../pages/AitoPage';

const project = {
  id: 12, description: 'Support GoPro', column: 'devis', position: 0, status: 'active',
  client_id: 'z1', client_name: 'ACME SARL', client_phone: '+33 6 12 34 56 78',
  created_at: '2026-07-01T10:00:00Z', updated_at: '2026-07-02T10:00:00Z',
};

beforeEach(() => {
  vi.mocked(localStorage.getItem).mockReset();
  vi.mocked(localStorage.setItem).mockReset();
  vi.mocked(localStorage.removeItem).mockReset();
  vi.mocked(localStorage.getItem).mockReturnValue(null);

  // Mock scrollIntoView which is not available in jsdom (useCardMorph calls
  // it before assigning the view-transition name).
  Element.prototype.scrollIntoView = vi.fn();

  server.use(
    http.get('/api/v1/aito/', () => HttpResponse.json([project])),
    http.get('/api/v1/zoho/status', () => HttpResponse.json({ configured: true, reachable: true })),
  );
});

describe('AitoPage (backend board)', () => {
  it('leads with the client name and a tel: phone link, without the row id', async () => {
    render(<AitoPage />);
    expect(await screen.findByText('ACME SARL')).toBeInTheDocument();
    expect(screen.queryByText('#12')).not.toBeInTheDocument();
    const tel = screen.getByRole('link', { name: '+33 6 12 34 56 78' });
    expect(tel).toHaveAttribute('href', 'tel:+33 6 12 34 56 78');
  });

  it('shows a placeholder title on clientless legacy cards', async () => {
    server.use(http.get('/api/v1/aito/', () =>
      HttpResponse.json([{ ...project, client_id: null, client_name: null, client_phone: null }])));
    render(<AitoPage />);
    expect(await screen.findByText('No client')).toBeInTheDocument();
    expect(screen.queryByText('#12')).not.toBeInTheDocument();
    expect(screen.queryByText('ACME SARL')).not.toBeInTheDocument();
  });

  it('shows the load-failed error state (with retry) when the board fetch fails, instead of the empty state', async () => {
    server.use(http.get('/api/v1/aito/', () => HttpResponse.json({ detail: 'boom' }, { status: 500 })));
    render(<AitoPage />);

    expect(await screen.findByText('Could not load the board.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('No projects yet')).not.toBeInTheDocument();
  });

  it('migrates localStorage cards once when backend board is empty', async () => {
    const imported = vi.fn();
    server.use(
      http.get('/api/v1/aito/', () => HttpResponse.json([])),
      http.post('/api/v1/aito/import', async ({ request }) => {
        imported(await request.json());
        return HttpResponse.json([], { status: 201 });
      }),
    );
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'aito-board-v1'
        ? JSON.stringify({
            devis: [{ id: 'x', description: 'legacy card', createdAt: '2026-07-01T00:00:00Z' }],
            model: [],
            print: [],
            finish: [],
          })
        : null,
    );

    render(<AitoPage />);

    await waitFor(() => expect(imported).toHaveBeenCalledWith({
      projects: [{ description: 'legacy card', column: 'devis', position: 0 }],
    }));
    expect(localStorage.removeItem).toHaveBeenCalledWith('aito-board-v1');
  });

  describe('hold-to-delete', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('fires DELETE after holding the button for 3s, with no confirm modal', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const deleteSpy = vi.fn();
      server.use(
        http.delete('/api/v1/aito/:id', ({ params }) => {
          deleteSpy(params.id);
          return new HttpResponse(null, { status: 204 });
        }),
      );

      render(<AitoPage />);
      const deleteButton = await screen.findByLabelText('Delete Project');

      await act(async () => {
        fireEvent.pointerDown(deleteButton);
        await vi.advanceTimersByTimeAsync(2000);
      });

      expect(deleteSpy).toHaveBeenCalledWith('12');
      // The old ConfirmModal rendered a "Delete" confirm button distinct
      // from the hold-to-delete control's "Delete Project" aria-label.
      expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    });

    it('cancels on early release without firing DELETE, and shows the hold hint', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const deleteSpy = vi.fn();
      server.use(
        http.delete('/api/v1/aito/:id', () => {
          deleteSpy();
          return new HttpResponse(null, { status: 204 });
        }),
      );

      render(<AitoPage />);
      const deleteButton = await screen.findByLabelText('Delete Project');

      await act(async () => {
        fireEvent.pointerDown(deleteButton);
        await vi.advanceTimersByTimeAsync(200);
        fireEvent.pointerUp(deleteButton);
      });

      expect(deleteSpy).not.toHaveBeenCalled();
      expect(await screen.findByText('Hold 2s to delete')).toBeInTheDocument();
    });
  });

  it('opens the detail panel with the full description, dates and stage', async () => {
    const user = userEvent.setup();
    render(<AitoPage />);
    await user.click(await screen.findByText('ACME SARL'));

    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('Support GoPro')).toBeInTheDocument();
    expect(within(panel).getByText('Created')).toBeInTheDocument();
    expect(within(panel).getByText('Last activity')).toBeInTheDocument();
    expect(within(panel).getByText('Stage')).toBeInTheDocument();
    expect(within(panel).getByText('Quote')).toBeInTheDocument();
  });

  it('opens the panel from the keyboard via the details button', async () => {
    const user = userEvent.setup();
    render(<AitoPage />);
    await screen.findByText('ACME SARL');
    await user.click(screen.getByRole('button', { name: 'Show details' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('closes the panel on Escape', async () => {
    const user = userEvent.setup();
    render(<AitoPage />);
    await user.click(await screen.findByText('ACME SARL'));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('drives the morph through startViewTransition when the API is present', async () => {
    const startViewTransition = vi.fn((cb: () => void) => {
      cb();
      return { finished: Promise.resolve(), ready: Promise.resolve(), updateCallbackDone: Promise.resolve() };
    });
    (document as { startViewTransition?: unknown }).startViewTransition = startViewTransition;
    const user = userEvent.setup();
    render(<AitoPage />);
    await user.click(await screen.findByText('ACME SARL'));
    await screen.findByRole('dialog');
    expect(startViewTransition).toHaveBeenCalled();
    delete (document as { startViewTransition?: unknown }).startViewTransition;
  });

  describe('trash view', () => {
    it('lists deleted projects and restores them', async () => {
      const restoreSpy = vi.fn();
      server.use(
        http.get('/api/v1/aito/trash', () =>
          HttpResponse.json([{ ...project, id: 12, description: 'Trashed doohickey' }]),
        ),
        http.post('/api/v1/aito/12/restore', () => {
          restoreSpy();
          return HttpResponse.json(project);
        }),
      );

      const user = userEvent.setup();
      render(<AitoPage />);
      await screen.findByText('ACME SARL');

      await user.click(screen.getByRole('button', { name: 'Trash' }));

      const modal = (await screen.findByText('Trashed doohickey')).closest('div.animate-modal-in') as HTMLElement;
      expect(modal).toBeTruthy();
      expect(within(modal).getByText('#12')).toBeInTheDocument();

      await user.click(within(modal).getByRole('button', { name: 'Restore' }));

      await waitFor(() => expect(restoreSpy).toHaveBeenCalled());
    });
  });
});
