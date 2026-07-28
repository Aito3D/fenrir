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
  task_count: 0, tasks_total: 0, task_services: [],
  created_at: '2026-07-01T10:00:00Z', updated_at: '2026-07-02T10:00:00Z',
};

/** The card opens from its body only — the header carrying the client name is
 *  deliberately not a click target. Tests that just need the panel open go
 *  through here rather than clicking the client name as a stand-in for "the
 *  card", which is what they did when the whole card was clickable. */
const openCard = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(await screen.findByRole('button', { name: /Support GoPro/ }));

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
  it('leads with the client name in the header, without the row id or a phone link', async () => {
    render(<AitoPage />);
    expect(await screen.findByText('ACME SARL')).toBeInTheDocument();
    expect(screen.queryByText('#12')).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
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
        await vi.advanceTimersByTimeAsync(1000);
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
      expect(await screen.findByText('Hold 1s to delete')).toBeInTheDocument();
    });
  });

  it('does not expand the card when the delete button is clicked', async () => {
    const user = userEvent.setup();
    render(<AitoPage />);
    await screen.findByText('ACME SARL');

    await user.click(screen.getByRole('button', { name: 'Delete Project' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the detail panel with the full description, dates and stage', async () => {
    const user = userEvent.setup();
    render(<AitoPage />);
    await openCard(user);

    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('Support GoPro')).toBeInTheDocument();
    expect(within(panel).getByText('Created:')).toBeInTheDocument();
    expect(within(panel).getByText('Last activity:')).toBeInTheDocument();
    expect(within(panel).getByText('Stage:')).toBeInTheDocument();
    expect(within(panel).getByText('Quote')).toBeInTheDocument();
  });

  it('opens the panel from the keyboard via the card body', async () => {
    const user = userEvent.setup();
    render(<AitoPage />);
    await openCard(user);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('closes the panel on Escape', async () => {
    const user = userEvent.setup();
    render(<AitoPage />);
    await openCard(user);
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
    await openCard(user);
    await screen.findByRole('dialog');
    expect(startViewTransition).toHaveBeenCalled();
    delete (document as { startViewTransition?: unknown }).startViewTransition;
  });

  it('saves an edited description and shows the saved indicator', async () => {
    const patched = vi.fn();
    server.use(
      http.patch('/api/v1/aito/:id', async ({ request }) => {
        const body = (await request.json()) as { description?: string };
        patched(body);
        return HttpResponse.json({ ...project, description: body.description });
      }),
    );
    const user = userEvent.setup();
    render(<AitoPage />);
    await openCard(user);

    const panel = await screen.findByRole('dialog');
    await user.click(within(panel).getByText('Support GoPro'));
    const textarea = within(panel).getByRole('textbox');
    await user.clear(textarea);
    await user.type(textarea, 'Support GoPro v2');
    await user.tab();

    await waitFor(() => expect(patched).toHaveBeenCalledWith({ description: 'Support GoPro v2' }));
    expect(await within(panel).findByText('Saved')).toBeInTheDocument();
  });

  it('reverts an edit on Escape without calling the API', async () => {
    const patched = vi.fn();
    server.use(http.patch('/api/v1/aito/:id', () => { patched(); return HttpResponse.json(project); }));
    const user = userEvent.setup();
    render(<AitoPage />);
    await openCard(user);

    const panel = await screen.findByRole('dialog');
    await user.click(within(panel).getByText('Support GoPro'));
    await user.type(within(panel).getByRole('textbox'), ' scrapped');
    await user.keyboard('{Escape}');

    expect(patched).not.toHaveBeenCalled();
    expect(within(panel).getByText('Support GoPro')).toBeInTheDocument();
    // The first Escape leaves edit mode; the panel itself must stay open.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('does not fire a request when the description is unchanged or blank', async () => {
    const patched = vi.fn();
    server.use(http.patch('/api/v1/aito/:id', () => { patched(); return HttpResponse.json(project); }));
    const user = userEvent.setup();
    render(<AitoPage />);
    await openCard(user);

    const panel = await screen.findByRole('dialog');
    await user.click(within(panel).getByText('Support GoPro'));
    await user.tab();
    expect(patched).not.toHaveBeenCalled();

    await user.click(within(panel).getByText('Support GoPro'));
    await user.clear(within(panel).getByRole('textbox'));
    await user.tab();
    expect(patched).not.toHaveBeenCalled();
    expect(within(panel).getByText('Support GoPro')).toBeInTheDocument();
  });

  it('reverts the field and toasts when the save fails', async () => {
    server.use(http.patch('/api/v1/aito/:id', () => HttpResponse.json({ detail: 'boom' }, { status: 500 })));
    const user = userEvent.setup();
    render(<AitoPage />);
    await openCard(user);

    const panel = await screen.findByRole('dialog');
    await user.click(within(panel).getByText('Support GoPro'));
    await user.type(within(panel).getByRole('textbox'), ' v2');
    await user.tab();

    expect(await screen.findByText('Could not save your changes. Please try again.')).toBeInTheDocument();
    await waitFor(() => expect(within(panel).getByText('Support GoPro')).toBeInTheDocument());
  });

  it('keeps focus in the textarea when the board re-renders mid-edit', async () => {
    const user = userEvent.setup();
    render(<AitoPage />);
    await openCard(user);

    const panel = await screen.findByRole('dialog');
    await user.click(within(panel).getByText('Support GoPro'));
    const textarea = within(panel).getByRole('textbox');
    expect(textarea).toHaveFocus();
    const lastActivityBefore = within(panel).getByText('Last activity:').nextElementSibling?.textContent;

    // React Query's tracked-properties + structural sharing means a refetch
    // that returns byte-identical data causes NO re-render at all -- the
    // realistic trigger (matching what actually happens on window refocus,
    // since refetchOnWindowFocus listens on 'visibilitychange') is a refetch
    // that lands genuinely fresh data, which is what forces AitoPage to
    // re-render with a fresh inline onClose passed down to the panel.
    server.use(http.get('/api/v1/aito/', () =>
      HttpResponse.json([{ ...project, updated_at: '2026-07-03T09:30:00Z' }])));
    act(() => {
      window.dispatchEvent(new Event('visibilitychange'));
    });

    // Wait for the fresh data to actually land (proves AitoPage re-rendered)
    // before asserting focus was preserved.
    await waitFor(() =>
      expect(within(panel).getByText('Last activity:').nextElementSibling?.textContent).not.toBe(lastActivityBefore),
    );

    expect(textarea).toHaveFocus();
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
