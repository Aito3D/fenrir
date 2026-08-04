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
import { api, ApiError, type AitoProject, type AitoTask, type ZohoQuotePreview } from '../../api/client';
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
  task_count: 0, tasks_total: 0, task_services: [], task_pending: [], steps_total: 0, steps_done: 0, task_steps: [],
  move_lock: null,
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
    quote_accepted_at: null,
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
    task_steps: [],
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
    http.get('/api/v1/zoho/status', () =>
      HttpResponse.json({
        configured: true,
        reachable: true,
        // The status endpoint always returns a default (walk-in) contact —
        // needed so the create-project tests below can submit the form
        // without picking a client of their own.
        default_contact_id: 'walk-in',
        default_contact_name: 'Client de passage',
      }),
    ),
  );
});

/** Overrides the board fixture and renders, for a test that needs specific
 *  initial data rather than the shared single-project fixture above. */
function renderPage(initialProjects: AitoProject[]) {
  server.use(http.get('/api/v1/aito/', () => HttpResponse.json(initialProjects)));
  render(<AitoPage />);
}

/** Opens the new-project drawer, prices the seeded task (a project needs at
 *  least one priced service to submit — see taskDraft.ts), gives the
 *  (still-default) walk-in contact a phone so it counts as reachable, and
 *  submits. Mirrors AitoPageClientSync.test.tsx's own `openDrawer` helper,
 *  collapsed into one call for tests that don't care about the client
 *  fields.
 *
 *  The description is no longer typed into a textarea — the drawer builds it
 *  from the AI summary (see AiSummaryPanel.tsx) — so `/aito/summarize` is
 *  stubbed here to answer with `description` verbatim, the same way
 *  AitoPageClientSync.test.tsx's fixed SUMMARY_TEXT does. */
async function createProject(description: string) {
  const user = userEvent.setup();
  server.use(
    http.post('/api/v1/aito/summarize', () => HttpResponse.json({ summary: description, model: 'test' })),
  );
  await user.click(await screen.findByRole('button', { name: 'Project' }));
  await screen.findByText(/Client account — Client de passage/);
  // The seeded task has no steps yet, so it is already showing its form, but
  // Scan is still a chip: enable it first to reach its cost field.
  await user.click(screen.getByRole('button', { name: 'Add Scan' }));
  fireEvent.change(screen.getByLabelText('Scan Cost'), { target: { value: '10' } });
  await user.click(screen.getByTestId('drawer-section-client'));
  await user.type(screen.getByLabelText(/^phone$/i), '87123456');
  await waitFor(() => expect(screen.getByLabelText('Project summary')).toHaveValue(description));
  await user.click(screen.getByRole('button', { name: /create project/i }));
}

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

      const deleteButton = await screen.findByLabelText('Move to trash');

      await act(async () => {
        fireEvent.pointerDown(deleteButton);
        await vi.advanceTimersByTimeAsync(1000);
      });

      expect(deleteSpy).toHaveBeenCalledWith('12');
      // The old ConfirmModal rendered a "Delete" confirm button distinct
      // from the hold-to-delete control's "Move to trash" aria-label.
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

      const deleteButton = await screen.findByLabelText('Move to trash');

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

    it('does not resurrect a deleted card via the task panel\'s unmount cleanup racing a pending delete', async () => {
      // Regression for the "useProjectTasks invalidates the board through
      // ungated paths" finding: ticking a step marks the panel dirty, and
      // that dirtiness used to invalidate `['aito-projects']` directly on
      // unmount — bypassing `useBoardSync` entirely. Closing the panel to
      // delete the card unmounts it while the DELETE is still in flight, and
      // that ungated invalidate fired a GET the delete's own `cancelQueries`
      // could not catch (it had already resolved) — the GET's answer, which
      // still shows the project (the DELETE hasn't committed server-side
      // yet), overwrote the optimistic removal and briefly resurrected the
      // card. Routing the invalidate through `resyncIfIdle` fixes it: while
      // `pendingWrites > 0` (the delete is in flight), the cleanup's
      // invalidate is a no-op, so nothing can undo the optimistic delete
      // until the delete itself settles.
      const boardTask: AitoTask = {
        id: 501,
        project_id: 12,
        position: 0,
        title: null,
        scan_cost: 500,
        modelisation_cost: null,
        usinage_cost: null,
        impression_printer_id: null,
        impression_filament_id: null,
        impression_weight_g: null,
        impression_time_min: null,
        impression_quantity: 1,
        impression_color: null,
        impression_cost: null,
        scan_done: false,
        modelisation_done: false,
        impression_done: false,
        usinage_done: false,
        created_at: '2026-07-27T00:00:00',
        updated_at: '2026-07-27T00:00:00',
      };
      const boardFetches = vi.fn();
      let releaseDelete: () => void = () => {};
      const heldDelete = new Promise<void>((resolve) => {
        releaseDelete = resolve;
      });
      server.use(
        http.get('/api/v1/aito/', () => {
          boardFetches();
          return HttpResponse.json([{ ...project, quote_status: 'accepted' }]);
        }),
        http.get('/api/v1/aito/12/tasks', () => HttpResponse.json([boardTask])),
        http.patch('/api/v1/aito/tasks/:id', () => HttpResponse.json({ ...boardTask, scan_done: true })),
        http.delete('/api/v1/aito/:id', async () => {
          await heldDelete;
          return new HttpResponse(null, { status: 204 });
        }),
      );

      const user = userEvent.setup();
      render(<AitoPage />);
      await waitFor(() => expect(boardFetches).toHaveBeenCalledTimes(1));

      await openCard(user);
      await user.click(await screen.findByRole('button', { name: /Scan/i }));
      // The tick's own immediate (and legitimately ungated, since nothing
      // else is in flight yet) board refresh — see "refreshes the board
      // immediately when a step is ticked" — must land before the delete
      // starts, so the assertions below isolate the unmount-cleanup race.
      await waitFor(() => expect(boardFetches).toHaveBeenCalledTimes(2));
      boardFetches.mockClear();

      const deleteButton = await screen.findByLabelText('Move to trash');
      fireEvent.pointerDown(deleteButton);
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 2000 });

      // The DELETE is still held open. No GET should have fired to
      // resurrect the card, and the card itself must not be back on screen.
      expect(boardFetches).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: /Support GoPro/ })).not.toBeInTheDocument();

      releaseDelete();
      await waitFor(() => expect(boardFetches).toHaveBeenCalled());
    });
  });

  it('opens the detail panel with the full description, dates and stage', async () => {
    // quote_number set: the Quote card is gated on it (a hand-made project
    // shows no Quote card at all), and this test wants to see it.
    server.use(http.get('/api/v1/aito/', () => HttpResponse.json([{ ...project, quote_number: 'DEV26-2462' }])));
    const user = userEvent.setup();
    render(<AitoPage />);
    await openCard(user);

    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('Support GoPro')).toBeInTheDocument();
    expect(within(panel).getByTestId('record-created')).toBeInTheDocument();
    expect(within(panel).getByTestId('record-activity')).toBeInTheDocument();
    // project.column is 'devis' — StageRail marks that stage's node current.
    expect(within(panel).getByTestId('stage-node-devis')).toHaveAttribute('data-state', 'current');
    // The heading itself, not a text match: StageRail's own 'devis' node also
    // reads "Quote" (aito.columns.devis), so an unscoped text query would
    // still pass with the Quote card deleted entirely.
    expect(within(panel).getAllByTestId('panel-card-heading').map((n) => n.textContent)).toContain('Quote');
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

  it('lets go of a project that disappears from the cache, so the panel is not stuck open in state', async () => {
    const user = userEvent.setup();
    render(<AitoPage />);
    await openCard(user);
    await screen.findByRole('dialog');

    // The row goes: another operator deleted it, or the delete button's own
    // optimistic write landed before the close transition's callback did.
    // The panel is derived from it, so it unmounts — but `expandedId` is not,
    // and nothing else would ever put it back to null.
    server.use(http.get('/api/v1/aito/', () => HttpResponse.json([])));
    act(() => {
      window.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // The row comes back. A stuck `expandedId` would re-derive the project and
    // pop the panel open again on its own, with nobody having asked for it —
    // and it would also freeze useCardFlight's snapshot map for good.
    server.use(http.get('/api/v1/aito/', () => HttpResponse.json([project])));
    act(() => {
      window.dispatchEvent(new Event('visibilitychange'));
    });
    await screen.findByRole('button', { name: /Support GoPro/ });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // And the card still opens, which a stuck `expandedId` would also break:
    // setting it to the id it already holds is not a state change.
    await openCard(user);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
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
    const lastActivityBefore = within(panel).getByTestId('record-activity').textContent;

    // React Query's tracked-properties + structural sharing means a refetch
    // that returns byte-identical data causes NO re-render at all -- the
    // realistic trigger (matching what actually happens on window refocus,
    // since refetchOnWindowFocus listens on 'visibilitychange') is a refetch
    // that lands genuinely fresh data, which is what forces AitoPage to
    // re-render with a fresh inline onClose passed down to the panel.
    // Mid-month noon, not the fixture's next morning: the record row renders
    // the DATE only now (the time lives in its tooltip), so the probe below
    // must change the rendered day in EVERY timezone — 07-03T09:30Z is still
    // 7/2 west of UTC-9, which made this exact assertion hang forever there.
    server.use(http.get('/api/v1/aito/', () =>
      HttpResponse.json([{ ...project, updated_at: '2026-07-15T12:00:00Z' }])));
    act(() => {
      window.dispatchEvent(new Event('visibilitychange'));
    });

    // Wait for the fresh data to actually land (proves AitoPage re-rendered)
    // before asserting focus was preserved.
    await waitFor(() =>
      expect(within(panel).getByTestId('record-activity').textContent).not.toBe(lastActivityBefore),
    );

    expect(textarea).toHaveFocus();
  });

  describe('quote import', () => {
    const emptyTask = {
      title: '',
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

      const drawer = (await screen.findByRole('dialog', { name: /import a quote/i })) as HTMLElement;
      await user.click(await screen.findByText('DEV26-2462'));

      // Waits for the preview to render (not just the description textarea,
      // which is seeded with the same text) before submitting.
      await within(drawer).findByText('Printing');
      await user.click(within(drawer).getByRole('button', { name: /^import$/i }));

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
    it('lists deleted projects as cards and restores them on a completed hold', async () => {
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

      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        render(<AitoPage />);
        await screen.findByText('ACME SARL');

        await user.click(screen.getByRole('button', { name: 'Trash' }));

        // A trashed project is the same CardView as everywhere else now, so
        // its description is the card's accessible name rather than a row of
        // plain text in a modal.
        await screen.findByRole('button', { name: /Trashed doohickey/ });
        // The one fact the board's cards do not carry: when it was deleted.
        expect(screen.getByText(/^Deleted /)).toBeInTheDocument();

        const restore = screen.getByRole('button', { name: 'Restore' });
        await user.pointer({ keys: '[MouseLeft>]', target: restore });
        // Short of the 500ms gate: a click is not a restore.
        act(() => {
          vi.advanceTimersByTime(300);
        });
        expect(restoreSpy).not.toHaveBeenCalled();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(300);
        });
        await waitFor(() => expect(restoreSpy).toHaveBeenCalled());
      } finally {
        vi.useRealTimers();
      }
    });

    it('fetches nothing until the trash view is opened', async () => {
      const trashSpy = vi.fn();
      server.use(
        http.get('/api/v1/aito/trash', () => {
          trashSpy();
          return HttpResponse.json([]);
        }),
      );

      const user = userEvent.setup();
      render(<AitoPage />);
      await screen.findByText('ACME SARL');

      // The button carries no count, which is the whole reason it is allowed
      // to cost nothing until it is pressed.
      expect(trashSpy).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Trash' }));
      await waitFor(() => expect(trashSpy).toHaveBeenCalled());
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
      quote_accepted_at: null,
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
      task_steps: [],
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
      // Only the in-flight-write poll test spies this one, but restore it
      // unconditionally for the same reason as above — a held-open mock
      // implementation left in place would swallow every later test's own
      // DELETE, MSW handler or not.
      if (vi.isMockFunction(api.deleteAitoProject)) vi.mocked(api.deleteAitoProject).mockRestore();
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

    it('skips a poll tick while a board write is in flight, and resumes once it settles', async () => {
      // Regression for "the board poll bypasses the settle guard": a poll
      // tick firing inside a write's [onMutate, onSettled] window used to
      // issue a fresh GET that overwrote the optimistic cache entry with
      // data that predates the write — silently, with no ring and no toast,
      // so it read as flakiness rather than a deliberate revert.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      // Two cards: #1 stays pending throughout (so the poll would keep
      // matching it regardless of the write below) and #2 is the one that
      // gets deleted. Deleting the ONLY pending card would stop the poll for
      // an unrelated reason (nothing left to match) and prove nothing about
      // the gate under test.
      const stillPending = { ...baseProject, id: 1, quote_sync_state: 'pending' as const, quote_number: null };
      const other = {
        ...baseProject,
        id: 2,
        description: 'Delete me',
        quote_sync_state: 'idle' as const,
        quote_number: 'DEV26-2',
      };
      const getAitoProjects = vi.spyOn(api, 'getAitoProjects').mockResolvedValue([stillPending, other]);
      getAitoProjects.mockClear();
      let releaseDelete: () => void = () => {};
      const heldDelete = new Promise<void>((resolve) => {
        releaseDelete = resolve;
      });
      vi.spyOn(api, 'deleteAitoProject').mockImplementation(() => heldDelete);

      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<AitoPage />);
      await waitFor(() => expect(getAitoProjects).toHaveBeenCalledTimes(1));

      await user.click(await screen.findByRole('button', { name: /Delete me/ }));
      const deleteButton = await screen.findByLabelText('Move to trash');
      await act(async () => {
        fireEvent.pointerDown(deleteButton);
        await vi.advanceTimersByTimeAsync(1000);
      });

      // Card #1 is still pending and still in the cache — only #2 was
      // optimistically removed — so the poll would still match it were it
      // not for the in-flight write. A whole poll interval elapses; the tick
      // must be skipped entirely, not merely delayed.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(getAitoProjects).toHaveBeenCalledTimes(1);

      // Settling re-triggers the poll's own evaluation (settle()'s
      // invalidate), and the skip must not have cost the poll its budget or
      // deadline — it keeps polling normally afterward.
      releaseDelete();
      await waitFor(() => expect(getAitoProjects.mock.calls.length).toBeGreaterThan(1));
      const callsAfterSettle = getAitoProjects.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(getAitoProjects.mock.calls.length).toBeGreaterThan(callsAfterSettle);
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
      render(<AitoPage />);

      await user.click(await screen.findByRole('button', { name: /doomed/ }));
      const deleteButton = await screen.findByLabelText('Move to trash');
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

      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        render(<AitoPage />);
        await screen.findByRole('button', { name: /On board/ });

        await user.click(screen.getByRole('button', { name: 'Trash' }));
        await screen.findByRole('button', { name: /Trashed thing/ });

        await user.pointer({ keys: '[MouseLeft>]', target: screen.getByRole('button', { name: 'Restore' }) });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(600);
        });

        // Optimistic, before the POST resolves: gone from the trash grid. This
        // one IS visible immediately in the DOM — the grid renders straight
        // from the page's ['aito-trash'] query, with no board-sync gating
        // between the cache write and the screen.
        await waitFor(() =>
          expect(screen.queryByRole('button', { name: /Trashed thing/ })).not.toBeInTheDocument(),
        );

        // ...and already on the board — via the wrapper's onMutate transform
        // (applyRestore) — before the POST resolves. This is the useBoardSync
        // counter split doing its job: a non-drag write (this restore) must
        // not block `useBoardDrag`'s local-board rebuild the way a drag's own
        // move does, so the card is on the board the moment you go back to it
        // rather than only in the cache.
        await user.click(screen.getByRole('button', { name: 'Back to board' }));
        await waitFor(() => expect(screen.getByRole('button', { name: /Trashed thing/ })).toBeInTheDocument());

        // The server refuses — the quote already has an active project.
        resolveRestore(HttpResponse.json({ detail: 'conflict' }, { status: 409 }));

        // Rolled back off the rendered board...
        await waitFor(() =>
          expect(screen.queryByRole('button', { name: /Trashed thing/ })).not.toBeInTheDocument(),
        );
        // ...and the trash row is back, via onError's invalidate.
        await user.click(screen.getByRole('button', { name: 'Trash' }));
        await screen.findByRole('button', { name: /Trashed thing/ });
        expect(await screen.findByText('That quote already has an active project')).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
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

  // Task 13: the only two writes left that used to hold a modal open through
  // a round trip. Both now close their modal in the click handler and hand
  // the user a placeholder card instead — inert (no grip, no expand, no
  // mark-sent) until the server's real row replaces it.
  describe('optimistic create and import', () => {
    afterEach(() => {
      vi.mocked(api.createAitoProject).mockRestore();
    });

    it('closes the modal and shows an inert placeholder card at once', async () => {
      // Controlled by hand, not answered until after the pending assertions
      // below — a create mocked to resolve immediately would make "still
      // pending" indistinguishable from "already settled".
      let release: (v: AitoProject) => void = () => {};
      vi.spyOn(api, 'createAitoProject').mockImplementation(
        () => new Promise((resolve) => { release = resolve; }),
      );
      renderPage([]);

      await createProject('a new job');

      // The modal is really gone, not just covered — its title text is the
      // one thing on screen that only exists while it is mounted.
      expect(screen.queryByText('New Project')).not.toBeInTheDocument();
      expect(screen.getByText('a new job')).toBeInTheDocument();
      // Inert: no grip, so it cannot be dragged before it exists server-side.
      expect(screen.queryByRole('button', { name: /drag/i })).not.toBeInTheDocument();

      const created = makeProject({ id: 42, description: 'a new job' });
      // The settle-invalidate refetches ['aito-projects'] once this is the
      // last write pending — the GET handler must already agree with the
      // server's answer, or that refetch would overwrite the just-landed
      // real row with the stale (empty) fixture.
      server.use(http.get('/api/v1/aito/', () => HttpResponse.json([created])));
      release(created);

      // Real once the server answers: the grip is back.
      await waitFor(() => expect(screen.getByRole('button', { name: /drag/i })).toBeInTheDocument());
    });

    it('removes the placeholder when the create fails', async () => {
      vi.spyOn(api, 'createAitoProject').mockRejectedValue(new Error('nope'));
      renderPage([]);

      await createProject('doomed job');

      await waitFor(() => expect(screen.queryByText('doomed job')).not.toBeInTheDocument());
    });

    describe('quote import', () => {
      // Minimal preview with one priced line — enough to satisfy
      // ImportQuoteModal's canImport gate (a task with a priced service) and
      // to render the "Printing" badge this suite waits on as its signal that
      // the preview actually loaded before submitting.
      const preview: ZohoQuotePreview = {
        quote: {
          id: 'e9',
          number: 'DEV26-9001',
          date: '2026-07-29',
          status: 'draft',
          total: 1200,
          currency_code: 'XPF',
          url: 'https://books.zoho.eu/app/999#/estimates/e9',
          salesperson: null,
        },
        client: { id: 'c9', name: 'Import Client', phone: '87000000', email: null, is_company: false },
        suggested_description: 'Imported job',
        tasks: [
          {
            title: '',
            scan_cost: null,
            modelisation_cost: null,
            usinage_cost: null,
            impression_printer_id: null,
            impression_filament_id: null,
            impression_weight_g: null,
            impression_time_min: null,
            impression_quantity: null,
            impression_color: null,
            impression_cost: 800,
          },
        ],
        skipped_lines: [],
        existing_project_id: null,
      };

      async function startImport(user: ReturnType<typeof userEvent.setup>) {
        server.use(
          http.get('/api/v1/zoho/estimates', () =>
            HttpResponse.json([
              {
                id: 'e9',
                number: 'DEV26-9001',
                customer_name: 'Import Client',
                date: '2026-07-29',
                total: 1200,
                currency_code: 'XPF',
                status: 'draft',
              },
            ]),
          ),
          http.get('/api/v1/zoho/estimates/:id/preview', () => HttpResponse.json(preview)),
        );
        await user.click(await screen.findByRole('button', { name: /^import$/i }));
        const drawer = (await screen.findByRole('dialog', { name: /import a quote/i })) as HTMLElement;
        await user.click(await screen.findByText('DEV26-9001'));
        // Waits for the preview to render before submitting — same signal the
        // pre-existing "POSTs the full quote snapshot" test above uses.
        await within(drawer).findByText('Printing');
        await user.click(within(drawer).getByRole('button', { name: /^import$/i }));
      }

      it('closes the modal and shows an inert placeholder card at once', async () => {
        let release: (v: AitoProject) => void = () => {};
        vi.spyOn(api, 'createAitoProject').mockImplementation(
          () => new Promise((resolve) => { release = resolve; }),
        );
        renderPage([]);
        const user = userEvent.setup();
        await startImport(user);

        expect(screen.queryByText('Import a quote')).not.toBeInTheDocument();
        expect(screen.getByText('Imported job')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /drag/i })).not.toBeInTheDocument();

        const created = makeProject({ id: 43, description: 'Imported job', quote_number: 'DEV26-9001' });
        server.use(http.get('/api/v1/aito/', () => HttpResponse.json([created])));
        release(created);

        await waitFor(() => expect(screen.getByRole('button', { name: /drag/i })).toBeInTheDocument());
      });

      it('removes the placeholder and toasts that the quote already has a project on a 409', async () => {
        vi.spyOn(api, 'createAitoProject').mockRejectedValue(new ApiError('conflict', 409));
        renderPage([]);
        const user = userEvent.setup();
        await startImport(user);

        await waitFor(() => expect(screen.queryByText('Imported job')).not.toBeInTheDocument());
        expect(await screen.findByText('This quote already has a project')).toBeInTheDocument();
        // Not the generic failure message — the 409 branch, specifically.
        expect(screen.queryByText('Could not create the project. Please try again.')).not.toBeInTheDocument();
      });

      it('lands the placeholder in Waiting, not Quote, when the imported quote is already sent', async () => {
        // `preview` above (status: 'draft') is the one value for which
        // forcing the placeholder onto Quote used to be accidentally
        // correct — every other status must relocate immediately, since a
        // sent/accepted/declined quote is the normal thing to import.
        const sentPreview: ZohoQuotePreview = { ...preview, quote: { ...preview.quote, status: 'sent' } };
        vi.spyOn(api, 'createAitoProject').mockImplementation(() => new Promise(() => {})); // never resolves
        server.use(
          http.get('/api/v1/zoho/estimates', () =>
            HttpResponse.json([
              {
                id: 'e9',
                number: 'DEV26-9001',
                customer_name: 'Import Client',
                date: '2026-07-29',
                total: 1200,
                currency_code: 'XPF',
                status: 'sent',
              },
            ]),
          ),
          http.get('/api/v1/zoho/estimates/:id/preview', () => HttpResponse.json(sentPreview)),
        );
        renderPage([]);
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: /^import$/i }));
        const drawer = (await screen.findByRole('dialog', { name: /import a quote/i })) as HTMLElement;
        await user.click(await screen.findByText('DEV26-9001'));
        await within(drawer).findByText('Printing');
        await user.click(within(drawer).getByRole('button', { name: /^import$/i }));

        const waitingColumn = screen.getByRole('heading', { name: 'Waiting' }).closest('.rounded-xl') as HTMLElement;
        expect(within(waitingColumn).getByText('Imported job')).toBeInTheDocument();
        const quoteColumn = screen.getByRole('heading', { name: 'Quote' }).closest('.rounded-xl') as HTMLElement;
        expect(within(quoteColumn).queryByText('Imported job')).not.toBeInTheDocument();
      });
    });

    // The direct proof that this uses `applyCreate`, not `applyRestore`: the
    // server's own `create_project` shifts every existing Devis card down and
    // inserts the new one at position 0, so a placeholder that merely
    // appended (as a restore does) would render at the bottom and then jump
    // to the top once the server answered — the exact double-jump this
    // feature exists to avoid.
    it('lands the new placeholder at the top of the Quote column, above an existing card', async () => {
      let release: (v: AitoProject) => void = () => {};
      vi.spyOn(api, 'createAitoProject').mockImplementation(
        () => new Promise((resolve) => { release = resolve; }),
      );
      renderPage([makeProject({ id: 5, description: 'already there', column: 'devis', position: 0 })]);

      await createProject('new on top');

      const quoteColumn = screen.getByRole('heading', { name: 'Quote' }).closest('.rounded-xl') as HTMLElement;
      const cards = within(quoteColumn).getAllByText(/^already there$|^new on top$/);
      expect(cards.map((el) => el.textContent)).toEqual(['new on top', 'already there']);

      const created = makeProject({ id: 44, description: 'new on top', column: 'devis', position: 0 });
      const shifted = makeProject({ id: 5, description: 'already there', column: 'devis', position: 1 });
      server.use(http.get('/api/v1/aito/', () => HttpResponse.json([shifted, created])));
      release(created);
      await waitFor(() => expect(screen.getByRole('button', { name: /new on top/ })).toBeInTheDocument());
    });
  });

  it('swaps the board for the done grid, and back', async () => {
    server.use(
      http.get('*/api/v1/aito/', () =>
        HttpResponse.json([
          makeProject({ id: 1, description: 'On the board', column: 'devis' }),
          makeProject({ id: 2, description: 'Archived work', column: 'done', move_lock: null }),
        ]),
      ),
    );
    const user = userEvent.setup();
    render(<AitoPage />);

    await screen.findByText('On the board');
    const toggle = screen.getByRole('button', { name: /show done/i });
    expect(toggle).toHaveTextContent('(1)');

    await user.click(toggle);
    expect(await screen.findByText('Archived work')).toBeInTheDocument();
    expect(screen.queryByText('On the board')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /back to board/i }));
    expect(await screen.findByText('On the board')).toBeInTheDocument();
  });

  it('marks the Show done toggle as the archive’s landing pad', async () => {
    render(<AitoPage />);
    const toggle = await screen.findByRole('button', { name: /show done/i });
    // useCardFlight flies a card that left the board for Done into whatever
    // carries this attribute. Renaming it silently would leave the archive
    // flight aimed at nothing.
    expect(toggle).toHaveAttribute('data-flight-target');
  });

  it('does not render a Done column on the board', async () => {
    server.use(
      http.get('*/api/v1/aito/', () =>
        HttpResponse.json([makeProject({ id: 1, description: 'Archived work', column: 'done' })]),
      ),
    );
    render(<AitoPage />);

    // The COUNT, not the bare button. The button mounts unconditionally, so
    // `findByRole('button', { name: /show done/i })` resolves in a microtask
    // before MSW ever answers — and the "Archived work" assertion below would
    // then run against an empty pre-fetch board, where it cannot fail. `(1)`
    // appears only once `board.done` actually holds the fetched row.
    await screen.findByRole('button', { name: /show done \(1\)/i });
    expect(screen.queryByRole('heading', { name: /^(Done|Terminé)$/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Archived work')).not.toBeInTheDocument();
  });

  // The board's empty region is three-way, and each arm says something the
  // other two would get wrong.
  describe('empty board', () => {
    it('says nothing is in production, not "no projects yet", when every project is done', async () => {
      // The board really is empty — counting the done column would claim it is
      // populated while showing six empty columns. But "No projects yet / add
      // your first card" is false directly above a Show done button reading
      // (1): there ARE projects, they are all finished.
      server.use(
        http.get('*/api/v1/aito/', () =>
          HttpResponse.json([makeProject({ id: 1, column: 'done' })]),
        ),
      );
      render(<AitoPage />);
      // Wait for the query to SETTLE before asserting. `board` is built from
      // `aitoQuery.data`, which is undefined until the fetch resolves — so
      // every column reads empty during the first render whether the count
      // sums the six rendered columns or all seven. A bare `findByText`
      // resolves on that transient state and would pass against the very bug
      // this test names.
      //
      // The count in the button, not the button itself: the button renders
      // unconditionally on mount, so its mere presence is not a settle signal.
      // `(1)` appears only once `board.done` holds the fetched row.
      await screen.findByRole('button', { name: /show done \(1\)/i });
      expect(screen.getByText(/nothing in production/i)).toBeInTheDocument();
      expect(screen.queryByText(/no projects yet|aucun projet/i)).not.toBeInTheDocument();
    });

    it('says there are no projects yet when nothing exists anywhere, archive included', async () => {
      server.use(http.get('*/api/v1/aito/', () => HttpResponse.json([])));
      render(<AitoPage />);

      await screen.findByRole('button', { name: /show done \(0\)/i });
      expect(screen.getByText(/no projects yet|aucun projet/i)).toBeInTheDocument();
      expect(screen.queryByText(/nothing in production/i)).not.toBeInTheDocument();
    });

    it('says the query matched nothing rather than leaving six blank columns', async () => {
      // The done grid already said this for the same query; the board said
      // nothing at all, so a search that matched no card looked like a bug.
      server.use(
        http.get('*/api/v1/aito/', () =>
          HttpResponse.json([makeProject({ id: 1, description: 'Support GoPro', column: 'devis' })]),
        ),
      );
      const user = userEvent.setup();
      render(<AitoPage />);
      await screen.findByText('Support GoPro');

      await user.type(screen.getByRole('searchbox'), 'zzzz');

      expect(screen.getByText(/no projects match|aucun projet ne correspond/i)).toBeInTheDocument();
      // Not the board-is-empty copy: the board is not empty, the query is.
      expect(screen.queryByText(/no projects yet|aucun projet pour/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/nothing in production/i)).not.toBeInTheDocument();
    });
  });

  it('filters board cards on the search query', async () => {
    server.use(
      http.get('*/api/v1/aito/', () =>
        HttpResponse.json([
          makeProject({ id: 1, description: 'Support GoPro', column: 'devis' }),
          makeProject({ id: 2, description: 'Boîtier étanche', column: 'scan', client_name: 'Dupont' }),
        ]),
      ),
    );
    const user = userEvent.setup();
    render(<AitoPage />);
    await screen.findByText('Support GoPro');

    await user.type(screen.getByRole('searchbox'), 'gopro');
    expect(screen.getByText('Support GoPro')).toBeInTheDocument();
    expect(screen.queryByText('Boîtier étanche')).not.toBeInTheDocument();
  });

  it('matches an unaccented query against accented card text', async () => {
    server.use(
      http.get('*/api/v1/aito/', () =>
        HttpResponse.json([makeProject({ id: 1, description: 'Boîtier étanche', column: 'devis' })]),
      ),
    );
    const user = userEvent.setup();
    render(<AitoPage />);
    await screen.findByText('Boîtier étanche');

    await user.type(screen.getByRole('searchbox'), 'etanche');
    expect(screen.getByText('Boîtier étanche')).toBeInTheDocument();
  });

  it('clears the query from the clear button', async () => {
    server.use(
      http.get('*/api/v1/aito/', () =>
        HttpResponse.json([
          makeProject({ id: 1, description: 'Support GoPro', column: 'devis' }),
          makeProject({ id: 2, description: 'Boîtier', column: 'scan' }),
        ]),
      ),
    );
    const user = userEvent.setup();
    render(<AitoPage />);
    await screen.findByText('Support GoPro');

    await user.type(screen.getByRole('searchbox'), 'gopro');
    expect(screen.queryByText('Boîtier')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /clear search|effacer la recherche/i }));
    expect(await screen.findByText('Boîtier')).toBeInTheDocument();
  });

  it('takes the grip off every card while a query is active', async () => {
    // A drop index computed against a filtered column is not the card's real
    // position, and the PATCH would persist the wrong one.
    server.use(
      http.get('*/api/v1/aito/', () =>
        HttpResponse.json([makeProject({ id: 1, description: 'Support GoPro', column: 'devis' })]),
      ),
    );
    const user = userEvent.setup();
    render(<AitoPage />);
    await screen.findByText('Support GoPro');
    expect(screen.getAllByRole('button', { name: /drag|glisser/i }).length).toBeGreaterThan(0);

    await user.type(screen.getByRole('searchbox'), 'gopro');
    expect(screen.queryByRole('button', { name: /drag|glisser/i })).not.toBeInTheDocument();
  });

  it('counts only the columns where work is actually happening', async () => {
    // Quote and Waiting are parked on the client, Done is finished. Scan,
    // Modeling, Printing and Finish are the bench.
    server.use(
      http.get('*/api/v1/aito/', () =>
        HttpResponse.json([
          makeProject({ id: 1, column: 'devis' }),
          makeProject({ id: 2, column: 'waiting' }),
          makeProject({ id: 3, column: 'scan' }),
          makeProject({ id: 4, column: 'model' }),
          makeProject({ id: 5, column: 'print' }),
          makeProject({ id: 6, column: 'finish' }),
          makeProject({ id: 7, column: 'done' }),
        ]),
      ),
    );
    render(<AitoPage />);

    // The <h1> renders unconditionally at mount, with `inProduction` stuck at
    // 0 while `aitoQuery.data` is still undefined — so a bare
    // `findByRole('heading', ...)` resolves on that very first render, before
    // the fetch above ever lands, and a plain `getByText('4')` right after it
    // would just be asserting against the transient pre-fetch 0. Waiting for
    // the Show Done button's own count first is a signal that only reads
    // `(1)` once the fetched board actually holds this fixture's one done
    // card, which guarantees the heading below reflects real data too.
    await screen.findByRole('button', { name: /show done \(1\)/i });
    const heading = screen.getByRole('heading', { level: 1 });
    expect(within(heading).getByText('4')).toBeInTheDocument();
  });

  it('reads as zero when everything is parked or finished', async () => {
    server.use(
      http.get('*/api/v1/aito/', () =>
        HttpResponse.json([
          makeProject({ id: 1, column: 'devis' }),
          makeProject({ id: 2, column: 'done' }),
        ]),
      ),
    );
    render(<AitoPage />);

    // Zero happens to be both the pre-fetch and the post-fetch value here, so
    // waiting on the heading alone would pass whether or not the real fetch
    // ever landed — it would even pass against a version of `inProduction`
    // that never read the board at all. The Show Done button's `(1)` only
    // appears once this fixture's one done card has actually loaded, so
    // waiting for it first proves the `0` below came from real data.
    await screen.findByRole('button', { name: /show done \(1\)/i });
    const heading = screen.getByRole('heading', { level: 1 });
    expect(within(heading).getByText('0')).toBeInTheDocument();
  });

  it('spells the count out for screen readers rather than leaving a bare number', async () => {
    server.use(
      http.get('*/api/v1/aito/', () =>
        HttpResponse.json([makeProject({ id: 1, column: 'print' })]),
      ),
    );
    render(<AitoPage />);
    expect(await screen.findByText(/1 project in production|1 projet en production/i)).toBeInTheDocument();
  });

  it('filters the Show-done count but not the title count', async () => {
    // Two different promises. The button's count says what the next click will
    // show, so it has to follow the query — offering "(2)" and then landing on
    // "No projects match your search" is a lie. The title's count describes
    // the shop, not the view, and must not flicker on every keystroke.
    server.use(
      http.get('*/api/v1/aito/', () =>
        HttpResponse.json([
          makeProject({ id: 1, description: 'Support GoPro', column: 'print' }),
          makeProject({ id: 2, description: 'Boîtier', column: 'finish' }),
          makeProject({ id: 3, description: 'GoPro archivé', column: 'done', move_lock: null }),
          makeProject({ id: 4, description: 'Boîtier archivé', column: 'done', move_lock: null }),
        ]),
      ),
    );
    const user = userEvent.setup();
    render(<AitoPage />);

    await screen.findByRole('button', { name: /show done \(2\)/i });
    expect(within(screen.getByRole('heading', { level: 1 })).getByText('2')).toBeInTheDocument();

    await user.type(screen.getByRole('searchbox'), 'gopro');

    // One of the two archived cards matches...
    expect(screen.getByRole('button', { name: /show done \(1\)/i })).toBeInTheDocument();
    // ...and the bench still holds two projects, query or no query.
    expect(within(screen.getByRole('heading', { level: 1 })).getByText('2')).toBeInTheDocument();
  });

  it('keeps the query when switching to the done grid', async () => {
    server.use(
      http.get('*/api/v1/aito/', () =>
        HttpResponse.json([
          makeProject({ id: 1, description: 'Support GoPro', column: 'devis' }),
          makeProject({ id: 2, description: 'GoPro archivé', column: 'done', move_lock: null }),
          makeProject({ id: 3, description: 'Boîtier archivé', column: 'done', move_lock: null }),
        ]),
      ),
    );
    const user = userEvent.setup();
    render(<AitoPage />);
    await screen.findByText('Support GoPro');

    await user.type(screen.getByRole('searchbox'), 'gopro');
    await user.click(screen.getByRole('button', { name: /show done/i }));

    expect(await screen.findByText('GoPro archivé')).toBeInTheDocument();
    expect(screen.queryByText('Boîtier archivé')).not.toBeInTheDocument();
  });
});
