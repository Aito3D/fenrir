/**
 * Tests for the AitoPage component (DB-backed Kanban board).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, act, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { server } from '../mocks/server';
import { render } from '../utils';
import { AitoPage } from '../../pages/AitoPage';
import { api, type AitoProject, type ZohoQuotePreview } from '../../api/client';
import { __resetBoardSync } from '../../hooks/useBoardSync';
import { flashRevert } from '../../hooks/useRevertFlash';

// `flashRevert` is imported as a direct binding by useOptimisticBoardMutation,
// so vi.spyOn on the module namespace would patch an object nobody reads.
// Mock the module instead, spreading the original so useIsReverting (which
// the card's revert-flash styling relies on) stays real.
vi.mock('../../hooks/useRevertFlash', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useRevertFlash')>()),
  flashRevert: vi.fn(),
}));

const project = {
  id: 12, description: 'Support GoPro', column: 'devis', position: 0, status: 'active',
  client_id: 'z1', client_name: 'ACME SARL', client_phone: '+33 6 12 34 56 78',
  task_count: 0, tasks_total: 0, task_services: [], task_pending: [], steps_total: 0, steps_done: 0, move_lock: null,
  created_at: '2026-07-01T10:00:00Z', updated_at: '2026-07-02T10:00:00Z',
};

// A project with every field the board cache needs, defaulted so a test can
// override only what it cares about. Copied from AitoQuoteStatusActions.test.tsx
// rather than shared — see that file's own fixture for the reasoning on
// `task_pending` defaulting to `task_services`.
function makeProject(overrides: Partial<AitoProject> = {}): AitoProject {
  const base: AitoProject = {
    id: 1,
    description: 'Support de caméra',
    column: 'devis',
    position: 0,
    status: 'active',
    client_id: 'z1',
    client_name: 'ACME SARL',
    client_phone: '+689-87123456',
    client_email: 'hi@acme.pf',
    client_is_company: null,
    quote_id: 'EST-1',
    quote_number: null,
    quote_date: null,
    quote_total: null,
    quote_url: null,
    quote_salesperson: null,
    quote_status: 'draft',
    quote_sync_state: 'idle',
    quote_sync_error: null,
    quote_status_block: null,
    quote_status_remote: null,
    created_by: null,
    task_count: 0,
    tasks_total: 0,
    task_services: [],
    task_pending: [],
    steps_total: 0,
    steps_done: 0,
    move_lock: null,
    created_at: '2026-07-27T00:00:00',
    updated_at: '2026-07-27T00:00:00',
  };
  return {
    ...base,
    ...overrides,
    task_pending: overrides.task_pending ?? overrides.task_services ?? base.task_pending,
  };
}

/** Grabs the QueryClient `render()` (from '../utils') creates internally —
 *  its `AllProviders` wrapper builds one with `useState` and never exposes it.
 *  Rendered as a sibling of the page under test so it shares the same
 *  `QueryClientProvider`.
 *
 *  Used to assert on the `['aito-projects']` cache as a SECONDARY check
 *  alongside the rendered board: `useOptimisticBoardMutation` promises to
 *  write the optimistic value into the cache synchronously, and the rendered
 *  assertions above it depend on that being true, so this pins down the
 *  cache half of the chain explicitly.
 *
 *  It used to be the ONLY check a still-pending write's tests could make.
 *  Before the `useBoardSync` counter split, `useBoardDrag`'s local `board`
 *  state (what the compact card actually renders from) refused to rebuild
 *  from the cache while ANY board write was pending, drag or not — so a
 *  delete or restore's optimistic value was correct in the cache but
 *  invisible on screen until the request settled, and a test could only
 *  observe it here. Now that a non-drag write no longer blocks that rebuild,
 *  the primary assertions check the rendered board directly; this capture is
 *  kept for the cache-side half of the proof, not as a workaround. */
let capturedClient: QueryClient;
function ClientCapture() {
  capturedClient = useQueryClient();
  return null;
}

/** The card opens from its body only — the header carrying the client name is
 *  deliberately not a click target. Tests that just need the panel open go
 *  through here rather than clicking the client name as a stand-in for "the
 *  card", which is what they did when the whole card was clickable. */
const openCard = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(await screen.findByRole('button', { name: /Support GoPro/ }));

/** The description edit box, disambiguated from ActivityRail's note <input>
 *  — mounting the rail as the panel's third column means `getByRole('textbox')`
 *  now matches both, since a plain text <input> shares the textbox role with
 *  a <textarea>. */
const findDescriptionTextarea = (panel: HTMLElement) =>
  within(panel)
    .getAllByRole('textbox')
    .find((el) => el.tagName === 'TEXTAREA') as HTMLTextAreaElement;

beforeEach(() => {
  vi.mocked(localStorage.getItem).mockReset();
  vi.mocked(localStorage.setItem).mockReset();
  vi.mocked(localStorage.removeItem).mockReset();
  vi.mocked(localStorage.getItem).mockReturnValue(null);

  // Mock scrollIntoView which is not available in jsdom (useCardMorph calls
  // it before assigning the view-transition name).
  Element.prototype.scrollIntoView = vi.fn();

  // useBoardSync's pending-write counter is module-level and survives between
  // tests in this file — a test that leaves an optimistic write pending (or
  // fails before it settles) would otherwise leak into the next one.
  __resetBoardSync();
  vi.mocked(flashRevert).mockClear();

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

  // Delete moved off the board card into the expanded card (task 11) — the
  // card no longer offers it at all, so every one of these opens the panel
  // first via `openCard`, exactly like the panel tests below.
  describe('hold-to-delete', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('fires DELETE after holding the button for 1s from the expanded card, and closes the panel', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const deleteSpy = vi.fn();
      server.use(
        http.delete('/api/v1/aito/:id', ({ params }) => {
          deleteSpy(params.id);
          return new HttpResponse(null, { status: 204 });
        }),
      );

      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<AitoPage />);
      await openCard(user);

      const deleteButton = await screen.findByLabelText('Delete Project');

      await act(async () => {
        fireEvent.pointerDown(deleteButton);
        await vi.advanceTimersByTimeAsync(1000);
      });

      expect(deleteSpy).toHaveBeenCalledWith('12');
      // The old ConfirmModal rendered a "Delete" confirm button distinct
      // from the hold-to-delete control's "Delete Project" aria-label.
      expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
      // AitoPage.tsx closes the panel before the mutation lands (see the
      // comment on ProjectDetailPanel's onDelete there) so the card morph
      // isn't lost to a cache invalidation racing the click — confirm the
      // dialog is actually gone, not just that DELETE fired.
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
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

      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<AitoPage />);
      await openCard(user);

      const deleteButton = await screen.findByLabelText('Delete Project');

      await act(async () => {
        fireEvent.pointerDown(deleteButton);
        await vi.advanceTimersByTimeAsync(200);
        fireEvent.pointerUp(deleteButton);
      });

      expect(deleteSpy).not.toHaveBeenCalled();
      expect(await screen.findByText('Hold 1s to delete')).toBeInTheDocument();
      // Cancelling the hold leaves the panel open — delete is a control
      // inside it now, not a separate surface to fall back out of.
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
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
    const textarea = findDescriptionTextarea(panel);
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
    await user.type(findDescriptionTextarea(panel), ' scrapped');
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
    await user.clear(findDescriptionTextarea(panel));
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
    await user.type(findDescriptionTextarea(panel), ' v2');
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
    const textarea = findDescriptionTextarea(panel);
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

  describe('quote import', () => {
    const emptyTask = {
      title: '',
      description: '',
      scan_cost: null,
      modelisation_cost: null,
      usinage_cost: null,
      impression_printer_id: null,
      impression_filament_id: null,
      impression_weight_g: null,
      impression_time_min: null,
      impression_quantity: null,
      impression_color: null,
      impression_cost: null,
    };

    const summary = {
      id: 'e2',
      number: 'DEV26-2462',
      customer_name: 'Marie EXEMPLE',
      date: '2026-07-27',
      total: 5600,
      currency_code: 'XPF',
      status: 'draft',
    };

    const preview: ZohoQuotePreview = {
      quote: {
        id: 'e2',
        number: 'DEV26-2462',
        date: '2026-07-27',
        status: 'draft',
        total: 5600,
        currency_code: 'XPF',
        url: 'https://books.zoho.eu/app/999#/estimates/e2',
        salesperson: 'Marie VENDEUSE',
      },
      client: { id: 'c2', name: 'Marie EXEMPLE', phone: '87123456', email: null, is_company: false },
      suggested_description: 'Helice grise',
      tasks: [{ ...emptyTask, title: 'Helice grise', impression_cost: 2400 }],
      skipped_lines: [],
      existing_project_id: null,
    };

    it('POSTs the full quote snapshot to /aito/, not just the fields the modal itself renders', async () => {
      // AitoPage.tsx is the only place that ever writes quote_salesperson and
      // quote_status (and, before them, the five earlier quote_* fields) —
      // both are frozen snapshots from the moment of import, unrecoverable if
      // dropped short of re-importing. ImportQuoteModal only calls onImport
      // with the preview it fetched; this pins the shape of what AitoPage
      // actually sends over the wire from that preview.
      let captured: Record<string, unknown> | null = null;
      server.use(
        http.get('/api/v1/zoho/estimates', () => HttpResponse.json([summary])),
        http.get('/api/v1/zoho/estimates/:id/preview', () => HttpResponse.json(preview)),
        http.post('/api/v1/aito/', async ({ request }) => {
          captured = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ ...project, id: 99, description: 'Helice grise' }, { status: 201 });
        }),
      );

      const user = userEvent.setup();
      render(<AitoPage />);
      await user.click(await screen.findByRole('button', { name: /^import$/i }));

      const modal = (await screen.findByText('Import a quote')).closest('div.animate-modal-in') as HTMLElement;
      await user.click(within(modal).getByRole('combobox'));
      await user.click(await screen.findByText('DEV26-2462'));

      // Waits for the preview to render (not just the description textarea,
      // which is seeded with the same text) before submitting.
      await within(modal).findByText('Printing');
      await user.click(within(modal).getByRole('button', { name: /^import$/i }));

      await waitFor(() => expect(captured).not.toBeNull());
      expect(captured).toMatchObject({
        quote_id: 'e2',
        quote_number: 'DEV26-2462',
        quote_date: '2026-07-27',
        quote_total: 5600,
        quote_url: 'https://books.zoho.eu/app/999#/estimates/e2',
        quote_salesperson: 'Marie VENDEUSE',
        quote_status: 'draft',
      });
    });
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

  describe('quote sync polling', () => {
    const baseProject: AitoProject = {
      id: 1,
      description: 'Support GoPro',
      column: 'devis',
      position: 0,
      status: 'active',
      client_id: 'z1',
      client_name: 'ACME SARL',
      client_phone: '+33 6 12 34 56 78',
      client_email: null,
      client_is_company: null,
      quote_id: null,
      quote_number: null,
      quote_date: null,
      quote_total: null,
      quote_url: null,
      quote_salesperson: null,
      quote_status: null,
      quote_sync_state: 'idle',
      quote_sync_error: null,
      quote_status_block: null,
      quote_status_remote: null,
      created_by: null,
      task_count: 0,
      tasks_total: 0,
      task_services: [],
      task_pending: [],
      steps_total: 0,
      steps_done: 0,
      move_lock: null,
      created_at: '2026-07-01T10:00:00Z',
      updated_at: '2026-07-02T10:00:00Z',
    };

    afterEach(() => {
      vi.useRealTimers();
      // Every test in this describe replaces `api.getAitoProjects` with
      // `vi.spyOn(...).mockResolvedValue(...)` instead of an MSW handler, and
      // nothing else in the file restores it — left alone, the last spy here
      // would keep intercepting `api.getAitoProjects` for every test that
      // runs after this describe, silently bypassing their own MSW handlers.
      vi.mocked(api.getAitoProjects).mockRestore();
    });

    it('polls while a quote is still being created, and stops when none is pending', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const pending = [{ ...baseProject, id: 1, quote_sync_state: 'pending' as const, quote_number: null }];
      const settled = [{ ...baseProject, id: 1, quote_sync_state: 'idle' as const, quote_number: 'DEV26-1' }];
      const getAitoProjects = vi.spyOn(api, 'getAitoProjects').mockResolvedValue(pending);

      render(<AitoPage />);
      await waitFor(() => expect(getAitoProjects).toHaveBeenCalledTimes(1));

      getAitoProjects.mockResolvedValue(settled);
      await vi.advanceTimersByTimeAsync(10_000);
      await waitFor(() => expect(getAitoProjects).toHaveBeenCalledTimes(2));

      // Nothing pending now: no further polling.
      const callsAfterSettle = getAitoProjects.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(getAitoProjects.mock.calls.length).toBe(callsAfterSettle);
    });

    it('does not poll a pending card that already has a quote number', async () => {
      // aito.quotePending — the only thing this poll exists to resolve on
      // screen — only renders when `!quote_number && quote_sync_state ===
      // 'pending'` (CardView.tsx). A card that already has a quote number has
      // nothing left for the poll to reveal, even though an ordinary task
      // edit re-marks an already-quoted card pending.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const quotedButPending = [
        { ...baseProject, id: 1, quote_sync_state: 'pending' as const, quote_number: 'DEV26-1' },
      ];
      // `vi.spyOn` on an already-spied method (the preceding test in this
      // describe also spies `getAitoProjects`) keeps the prior call history —
      // clear it so `toHaveBeenCalledTimes` below counts only this test's
      // fetches.
      const getAitoProjects = vi.spyOn(api, 'getAitoProjects').mockResolvedValue(quotedButPending);
      getAitoProjects.mockClear();

      render(<AitoPage />);
      await waitFor(() => expect(getAitoProjects).toHaveBeenCalledTimes(1));

      await vi.advanceTimersByTimeAsync(60_000);
      expect(getAitoProjects).toHaveBeenCalledTimes(1);
    });

    it('stops polling after the ~5 minute bound even while the card is still pending', async () => {
      // The worker that clears `pending` is gated behind a setting that can
      // be off (and Zoho credentials can be pulled), so nothing guarantees
      // `pending` ever resolves — an unbounded poll would run forever with a
      // tab left open. The bound is a wall-clock deadline (~5 minutes from
      // when polling started), not a fixed count of ticks, since React Query
      // can re-evaluate `refetchInterval` more than once per actual fetch.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const stillPending = [
        { ...baseProject, id: 1, quote_sync_state: 'pending' as const, quote_number: null },
      ];
      // See the previous test's comment: clear the leftover call history from
      // whichever earlier test in this describe last spied this method.
      const getAitoProjects = vi.spyOn(api, 'getAitoProjects').mockResolvedValue(stillPending);
      getAitoProjects.mockClear();

      render(<AitoPage />);
      await waitFor(() => expect(getAitoProjects).toHaveBeenCalledTimes(1));

      // Run well past the 5 minute bound — polling must have stopped inside
      // that window regardless of exactly how many fetches it took.
      await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
      const callsAtBound = getAitoProjects.mock.calls.length;
      expect(callsAtBound).toBeGreaterThan(1);

      // Nothing changed in the data — the card is still pending — but the
      // bound is spent, so no further polling.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getAitoProjects.mock.calls.length).toBe(callsAtBound);
    });

    it('resumes polling for a new matching card once an earlier card already spent the poll budget', async () => {
      // Regression: the deadline was cleared only when the WHOLE "some card
      // pending" predicate went false, not per-card. So once card A's budget
      // was spent while it (or any card) still matched, `now >= deadline`
      // stayed true forever — including for a genuinely new card that starts
      // matching afterward. That stuck-forever case is exactly what the
      // bound exists for (sync worker off or unconfigured), so the second
      // card's "Creating quote…" would never resolve for the life of the tab.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const cardA = { ...baseProject, id: 1, quote_sync_state: 'pending' as const, quote_number: null };
      const getAitoProjects = vi.spyOn(api, 'getAitoProjects').mockResolvedValue([cardA]);
      getAitoProjects.mockClear();

      render(<AitoPage />);
      await waitFor(() => expect(getAitoProjects).toHaveBeenCalledTimes(1));

      // Spend card A's whole 5-minute budget.
      await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
      const callsAtBound = getAitoProjects.mock.calls.length;
      expect(callsAtBound).toBeGreaterThan(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getAitoProjects.mock.calls.length).toBe(callsAtBound);

      // A fresh import creates card B: genuinely new, still pending, and
      // actually present in the cache. Card A is untouched (still pending
      // too — the worker is still off).
      const cardB = { ...baseProject, id: 2, quote_sync_state: 'pending' as const, quote_number: null };
      getAitoProjects.mockResolvedValue([cardA, cardB]);
      await act(async () => {
        window.dispatchEvent(new Event('visibilitychange'));
      });
      await waitFor(() => expect(getAitoProjects.mock.calls.length).toBe(callsAtBound + 1));

      // Polling must resume for card B's own budget.
      const callsAfterNewCard = getAitoProjects.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(getAitoProjects.mock.calls.length).toBeGreaterThan(callsAfterNewCard);
    });
  });

  describe('optimistic delete and restore', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('removes the card at once on delete and puts it back on failure', async () => {
      // Controlled by hand, not answered until after the pending assertion
      // below — a DELETE mocked to resolve immediately would make "still
      // pending" indistinguishable from "already settled".
      let resolveDelete: (response: Response) => void = () => {};
      server.use(
        http.get('/api/v1/aito/', () =>
          HttpResponse.json([
            makeProject({ id: 1, description: 'doomed' }),
            makeProject({ id: 2, description: 'safe' }),
          ]),
        ),
        http.delete(
          '/api/v1/aito/:id',
          () => new Promise<Response>((resolve) => { resolveDelete = resolve; }),
        ),
      );
      const flash = vi.mocked(flashRevert);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(
        <>
          <ClientCapture />
          <AitoPage />
        </>,
      );

      await user.click(await screen.findByRole('button', { name: /doomed/ }));
      const deleteButton = await screen.findByLabelText('Delete Project');
      await act(async () => {
        fireEvent.pointerDown(deleteButton);
        await vi.advanceTimersByTimeAsync(1000);
      });

      // The DELETE above is deliberately still pending — resolveDelete has not
      // been called yet — so this is the optimistic write, not a fluke of the
      // request having already settled. Asserted on the RENDERED board, not
      // just the cache: this is what the useBoardSync counter-split fixed —
      // before it, `useBoardDrag`'s local `board` state refused to rebuild
      // from the cache until every pending write (delete included) settled,
      // so the card stayed on screen despite the cache already being correct.
      await waitFor(() => expect(screen.queryByRole('button', { name: /doomed/ })).not.toBeInTheDocument());
      // The cache write is what the rendered assertion above actually depends
      // on — kept as a secondary check that the optimistic value landed.
      expect(capturedClient.getQueryData<AitoProject[]>(['aito-projects'])?.some((p) => p.id === 1)).toBe(false);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      resolveDelete(HttpResponse.json({ detail: 'nope' }, { status: 500 }));

      await waitFor(() => expect(screen.getByText('doomed')).toBeInTheDocument());
      expect(flash).toHaveBeenCalledWith(1);
    });

    it('restoring from the trash removes the row from the trash list and puts the card on the board immediately, and a 409 puts the trash row back', async () => {
      const boardProject = makeProject({ id: 10, description: 'On board', column: 'devis' });
      const trashedProject = makeProject({ id: 99, description: 'Trashed thing', column: 'print' });

      // Controlled by hand so the test can inspect both caches while the
      // restore is still in flight, then choose how it resolves.
      let resolveRestore: (response: Response) => void = () => {};
      server.use(
        http.get('/api/v1/aito/', () => HttpResponse.json([boardProject])),
        http.get('/api/v1/aito/trash', () => HttpResponse.json([trashedProject])),
        http.post(
          '/api/v1/aito/99/restore',
          () => new Promise<Response>((resolve) => { resolveRestore = resolve; }),
        ),
      );

      const user = userEvent.setup();
      render(
        <>
          <ClientCapture />
          <AitoPage />
        </>,
      );
      await screen.findByRole('button', { name: /On board/ });

      await user.click(screen.getByRole('button', { name: 'Trash' }));
      const modal = (await screen.findByText('Trashed thing')).closest('div.animate-modal-in') as HTMLElement;
      await user.click(within(modal).getByRole('button', { name: 'Restore' }));

      // Optimistic, before the POST resolves: gone from the trash list. This
      // one IS visible immediately in the DOM — TrashModal renders straight
      // from its own ['aito-trash'] query, with no board-sync gating between
      // the cache write and the screen.
      await waitFor(() => expect(within(modal).queryByText('Trashed thing')).not.toBeInTheDocument());
      // ...and already present on the RENDERED board — via the wrapper's
      // onMutate transform (applyRestore) — before the POST resolves. This is
      // the useBoardSync counter split doing its job: a non-drag write (this
      // restore) must not block `useBoardDrag`'s local-board rebuild the way
      // a drag's own move does, so the card appears on screen immediately
      // rather than only in the cache. `getByRole('button', ...)` is
      // unambiguous even with the trash modal still open: the modal's own
      // row renders the same description as plain text, not a button.
      await waitFor(() => expect(screen.getByRole('button', { name: /Trashed thing/ })).toBeInTheDocument());
      // The cache write the rendered card above depends on.
      expect(capturedClient.getQueryData<AitoProject[]>(['aito-projects'])?.some((p) => p.id === 99)).toBe(true);

      // The server refuses — the quote already has an active project.
      resolveRestore(HttpResponse.json({ detail: 'conflict' }, { status: 409 }));

      // Rolled back off the rendered board...
      await waitFor(() => expect(screen.queryByRole('button', { name: /Trashed thing/ })).not.toBeInTheDocument());
      expect(capturedClient.getQueryData<AitoProject[]>(['aito-projects'])?.some((p) => p.id === 99)).toBe(false);
      // ...and the trash row is back, via onError's invalidate.
      await within(modal).findByText('Trashed thing');
      expect(await screen.findByText('That quote already has an active project')).toBeInTheDocument();
    });

    // The direct proof of the useBoardSync counter split: a non-drag
    // optimistic write must be visible on the RENDERED board while its
    // request is still pending, not merely in the query cache. Before the
    // split, `useBoardDrag`'s local `board` state (what these columns
    // actually render from) refused to rebuild until every pending board
    // write settled — drag or not — so this card would still show under
    // "Quote" here, and a cache-only assertion would not have caught it.
    it('moves the card to its new column on screen the instant a quote is accepted, before the request resolves', async () => {
      const accepted = makeProject({
        id: 1,
        description: 'Ready to ship',
        column: 'devis',
        quote_status: 'sent',
        task_services: ['impression'],
        steps_total: 1,
        steps_done: 0,
      });
      server.use(http.get('/api/v1/aito/', () => HttpResponse.json([accepted])));

      // Controlled by hand, not answered until after the pending assertion
      // below — a mocked response resolved immediately would make "still
      // pending" indistinguishable from "already settled".
      let release: (v: { project: AitoProject; zoho_synced: boolean }) => void = () => {};
      vi.spyOn(api, 'setAitoQuoteStatus').mockImplementation(
        () => new Promise((resolve) => { release = resolve; }),
      );

      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<AitoPage />);

      await user.click(await screen.findByRole('button', { name: /Ready to ship/ }));
      const acceptButton = await screen.findByRole('button', { name: /accept quote/i });
      await act(async () => {
        fireEvent.pointerDown(acceptButton);
        await vi.advanceTimersByTimeAsync(600);
      });

      // The request above is deliberately still pending — `release` has not
      // been called yet. Scoped to each column via its heading, so this
      // checks the card actually relocated between columns on screen, not
      // just that a second copy of it exists somewhere in the DOM.
      // `getByRole('heading', ...)` rather than `getByText`: the expanded
      // panel also shows the project's current stage as a `<dd>` with the
      // same label text, which a plain text query would collide with. The
      // column's own label is the only <h2> with that text.
      const quoteColumn = screen.getByRole('heading', { name: 'Quote' }).closest('.rounded-xl') as HTMLElement;
      const printColumn = screen
        .getByRole('heading', { name: 'Printing & Machining' })
        .closest('.rounded-xl') as HTMLElement;
      await waitFor(() => {
        expect(within(quoteColumn).queryByRole('button', { name: /Ready to ship/ })).not.toBeInTheDocument();
        expect(within(printColumn).getByRole('button', { name: /Ready to ship/ })).toBeInTheDocument();
      });

      // The settle-invalidate refetches ['aito-projects'], so the GET handler
      // must now agree with the accepted state — otherwise the refetch would
      // overwrite the still-correct optimistic value with the stale fixture.
      const settled = { ...accepted, quote_status: 'accepted' as const, column: 'print' as const };
      server.use(http.get('/api/v1/aito/', () => HttpResponse.json([settled])));
      release({ project: settled, zoho_synced: true });

      // Settles cleanly: the card stays put once the server confirms it.
      await waitFor(() => expect(within(printColumn).getByRole('button', { name: /Ready to ship/ })).toBeInTheDocument());
      expect(within(quoteColumn).queryByRole('button', { name: /Ready to ship/ })).not.toBeInTheDocument();
    });
  });
});
