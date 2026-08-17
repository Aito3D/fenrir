/**
 * Optimistic coverage for `useProjectTasks` (Task 11): a task edit, add or
 * delete must show on the BOARD CARD behind the panel at once — total,
 * badges, progress bar and column — not only in the panel itself, and an
 * add/delete must show and un-show its row without waiting for a round trip.
 *
 * Exercised through `ProjectDetailPanel` (not the hook in isolation, like
 * `useProjectTasks.test.tsx` does) because the thing under test —
 * `projectOntoBoard` writing into the `['aito-projects']` cache — has no
 * effect the hook's own return value exposes; the cache is the only witness.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within, waitFor, act, fireEvent, render as rtlRender } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { ProjectDetailPanel } from '../../components/aito/ProjectDetailPanel';
import { AuthProvider } from '../../contexts/AuthContext';
import { ToastProvider } from '../../contexts/ToastContext';
import { api } from '../../api/client';
import type { AitoProject, AitoTask } from '../../api/client';

// A project with every field the board cache needs, defaulted so a test can
// override only what it cares about. Copied from AitoDetailPanelOptimistic.
// test.tsx rather than shared — see that file's own fixture for the
// reasoning on `task_pending` defaulting to `task_services`.
function makeProject(overrides: Partial<AitoProject> = {}): AitoProject {
  const base: AitoProject = {
    id: 1,
    description: 'Support de caméra',
    column: 'devis',
    position: 0,
    status: 'active',
    client_id: 'z1',
    client_name: 'ACME SARL',
    client_phone: null,
    client_email: null,
    client_is_company: null,
    client_social_network: null,
    client_social_handle: null,
    quote_id: null,
    quote_number: null,
    quote_date: null,
    quote_total: null,
    quote_url: null,
    quote_salesperson: null,
    quote_status: null,
    quote_accepted_at: null,
    quote_sync_state: 'idle',
    quote_invoiced: false,
    flag: null,
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
    shipping_island: null,
    shipping_service: null,
    shipping_first_name: null,
    shipping_last_name: null,
    shipping_phone: null,
    shipping_price: null,
    shipping_service_name: null,
    version: 1,
    created_at: '2026-07-27T00:00:00',
    updated_at: '2026-07-27T00:00:00',
  };
  return {
    ...base,
    ...overrides,
    task_pending: overrides.task_pending ?? overrides.task_services ?? base.task_pending,
  };
}

function makeTask(overrides: Partial<AitoTask> = {}): AitoTask {
  const base: AitoTask = {
    id: 1,
    project_id: 1,
    position: 0,
    title: null,
    scan_cost: null,
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
    created_at: '2026-07-29T00:00:00',
    updated_at: '2026-07-29T00:00:00',
  };
  return { ...base, ...overrides };
}

const mockDefaults = {
  id: 1,
  electricity_tariff: 120,
  labor_rate_per_hour: 3000,
  consumables_packaging_flat: 30,
  failure_rate_pct: 30,
  prototype_rate_pct: 30,
  ads_rate_pct: 5,
  filament_markup_pct: 5,
  global_markup_pct: 50,
  tax_pct: 13,
  default_difficulty_pct: 100,
  default_margin_over_cost_pct: 50,
  stuff_markup_pct: 20,
  updated_at: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  // ImpressionFields (mounted unconditionally inside TaskStepFields, i.e.
  // whenever a row is in edit mode) always queries these three, and TaskRow /
  // TaskEditor / TaskStepList all query settings for the configured currency
  // — none of that is what these tests are about.
  vi.spyOn(api, 'getCalculatorFilaments').mockResolvedValue([]);
  vi.spyOn(api, 'getCalculatorPrinters').mockResolvedValue([]);
  vi.spyOn(api, 'getCalculatorDefaults').mockResolvedValue(mockDefaults);
  vi.spyOn(api, 'getAitoEvents').mockResolvedValue({ events: [], has_more: false });

  // Sane defaults for the three write endpoints, echoing the patch/body back
  // onto a fresh row. Individual tests below replace these with a pending or
  // rejected implementation where the test is about that failure/latency
  // path; the ones that aren't (the debounce test) rely on this default.
  vi.spyOn(api, 'updateAitoTask').mockImplementation(async (id, patch) => ({ ...makeTask({ id }), ...patch }));
  vi.spyOn(api, 'createAitoTask').mockImplementation(async (projectId, data) => ({
    ...makeTask({ id: 999, project_id: projectId }),
    ...data,
  }));
  vi.spyOn(api, 'deleteAitoTask').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  // A throw inside `holdDelete`'s act block (fake timers are switched on for
  // the hold-to-delete tests) would otherwise skip the matching
  // `vi.useRealTimers()` further down and leak fake timers into every test
  // that runs after it in this file.
  vi.useRealTimers();
});

/** Renders `ProjectDetailPanel` against a real QueryClient seeded with one
 *  project, and returns that client so a test can inspect the
 *  `['aito-projects']` cache directly — the only witness to
 *  `projectOntoBoard`'s write, since the hook's own return value never
 *  exposes it. `BrowserRouter` is required because ImpressionFields (mounted
 *  whenever a row enters edit mode) renders a react-router `Link`. */
async function renderTasks({
  projectId,
  project,
  tasks,
}: {
  projectId: number;
  project?: AitoProject;
  tasks: AitoTask[];
}) {
  vi.spyOn(api, 'getAitoTasks').mockResolvedValue(tasks);
  const resolvedProject = project ?? makeProject({ id: projectId });

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(['aito-projects'], [resolvedProject]);

  rtlRender(
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <AuthProvider>
          <ToastProvider>
            <ProjectDetailPanel canCreate canUpdate canDelete project={resolvedProject} onClose={() => {}} onDelete={() => {}} />
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>,
  );

  // Let the initial `getAitoTasks` fetch resolve and apply before a test
  // starts interacting: an "Add task" click issued before this settles would
  // optimistically append a placeholder that the resync effect then wipes the
  // instant the (real) fetch lands — a race this task's own optimism
  // introduces (the old add flow had no local state to stomp), and one no
  // production click is fast enough to hit against an already-open panel.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  return client;
}

const SERVICE_LABELS: Record<'scan' | 'modelisation' | 'impression' | 'usinage', string> = {
  scan: 'Scan',
  modelisation: 'Modeling',
  impression: 'Printing',
  usinage: 'Machining',
};

/** Clicks that service's Done toggle in the read-only `TaskStepList` (not
 *  edit mode — ticking is a one-click action, never a form field). The row is
 *  already open — Task 17 removed the disclosure a click here used to have to
 *  get past. */
async function tickStep(service: keyof typeof SERVICE_LABELS) {
  const row = screen.getByText(SERVICE_LABELS[service]).closest('li')!;
  await userEvent.click(within(row).getByRole('button', { name: new RegExp(SERVICE_LABELS[service]) }));
}

/** Holds the row's delete button for its full 1s, the same gesture
 *  `DeleteHoldButton`/`HoldButton` require in production — mirrors
 *  ProjectDetailPanel.test.tsx's own `fireEvent.pointerDown` +
 *  `vi.advanceTimersByTimeAsync(1000)` pattern so the hold is fast-forwarded
 *  under fake timers instead of costing a real second of wall-clock time per
 *  call (the confirmed source of an intermittent CI timeout). */
async function holdDelete(index: number) {
  const removeButtons = screen.getAllByLabelText('Remove task');
  const before = screen.getAllByRole('heading', { level: 4 }).length;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // A raw `pointerdown`, not `userEvent.pointer`: jsdom has no layout engine,
  // so `userEvent.pointer`'s own enter/leave synthesis (which consults
  // `elementFromPoint`) reads the synthetic pointer as having immediately
  // left the button and cancels the hold before its timer ever starts.
  // Mirrors ProjectDetailPanel.test.tsx's own hold-to-delete tests.
  await act(async () => {
    fireEvent.pointerDown(removeButtons[index]);
    await vi.advanceTimersByTimeAsync(1000);
  });
  // Back to real timers before polling: `waitFor`'s own interval needs wall
  // clock to advance, and everything else in this file (including
  // `renderTasks`'s settle-the-initial-fetch `act`) runs under real timers.
  vi.useRealTimers();
  // Asserted on the DOM itself, not on `api.deleteAitoTask` having been
  // called — the mock can be observed as called a tick before React has
  // committed the optimistic removal it's fired from, since both happen
  // inside the same timer callback rather than a wrapped React event.
  await waitFor(() => expect(screen.getAllByRole('heading', { level: 4 })).toHaveLength(before - 1), {
    timeout: 2000,
  });
}

/** Switches the project's only task row into edit mode and rewrites its Scan
 *  Cost field. `id` documents which row a caller means; every test that uses
 *  this helper seeds exactly one task, so there is only one row to find. */
async function editCost(_id: number, value: string) {
  await userEvent.click(screen.getByRole('button', { name: /edit task/i }));
  const input = await screen.findByLabelText('Scan Cost');
  await userEvent.clear(input);
  await userEvent.type(input, value);
}

describe('useProjectTasks optimistic board projection', () => {
  it('projects a step tick onto the board card at once', async () => {
    let release: (v: unknown) => void = () => {};
    vi.mocked(api.updateAitoTask).mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const client = await renderTasks({
      projectId: 1,
      project: makeProject({ id: 1, quote_status: 'accepted', column: 'print', steps_total: 2, steps_done: 0 }),
      tasks: [makeTask({ id: 10, impression_cost: 5, usinage_cost: 5 })],
    });

    await tickStep('impression');

    // The optimistic board write happens synchronously inside `onTasksChange`
    // — it does not wait for the debounced PATCH `updateAitoTask` above is
    // still holding open, which is the point: this assertion would be
    // meaningless if it only passed once the network call resolved.
    const cached = client.getQueryData<AitoProject[]>(['aito-projects'])![0];
    expect(cached.steps_done).toBe(1);
    release(null);
  });

  it('shows a new task row before the POST resolves, and removes it on failure', async () => {
    vi.mocked(api.createAitoTask).mockRejectedValue(new Error('nope'));
    await renderTasks({ projectId: 1, tasks: [] });

    // A synchronous `fireEvent.click`, not `userEvent.click`: the latter
    // wraps its dispatch in an async `act` that drains every pending
    // microtask, and `createAitoTask` here rejects on the very next one — so
    // by the time an awaited `userEvent.click` resolved, the placeholder
    // would already have been added AND removed again, and the assertion
    // below would never observe the row actually being there.
    fireEvent.click(await screen.findByRole('button', { name: /add task/i }));
    expect(screen.getAllByRole('heading', { level: 4 })).toHaveLength(1);

    await waitFor(() => expect(screen.queryAllByRole('heading', { level: 4 })).toHaveLength(0));
  });

  it('disables a new row while its create is in flight, and enables it once the id lands', async () => {
    // Regression for CRITICAL 1: the row is forced into edit mode because it
    // has no steps yet — see TaskEditor's `isEditing` (read mode would show
    // nothing but "No steps yet"). That form used to stay fully live for the
    // whole POST round trip. Anything typed into it in that window was
    // silently overwritten the instant `onSuccess` swapped the placeholder
    // for the server's echo of the ORIGINAL, still-empty draft `mutate`
    // captured. The fix is to make the row inert (disabled inputs) until its
    // id lands, not to replay the edits afterwards.
    let resolveCreate: (task: AitoTask) => void = () => {};
    vi.mocked(api.createAitoTask).mockImplementation(
      () => new Promise((resolve) => { resolveCreate = resolve; }),
    );
    await renderTasks({ projectId: 1, tasks: [] });

    fireEvent.click(await screen.findByRole('button', { name: /add task/i }));

    // The row shows its form immediately — it has no steps yet, so there is
    // nothing else it could show — and that form must be inert while nothing
    // has an id to PATCH yet.
    const title = await screen.findByRole('textbox', { name: 'Optional title' });
    expect(title).toBeDisabled();

    resolveCreate(makeTask({ id: 202, project_id: 1 }));

    // The id landing swaps the row's key from `draft:<uid>` to
    // `persisted:202` — a fresh TaskRow instance, but still stepless (the
    // server echoed back the still-empty draft), so it keeps showing the same
    // form rather than falling back to a read-only "No steps yet". What this
    // fix guarantees is that the form is no longer inert once the id lands —
    // a permanently disabled row would be exactly as much a data-loss trap as
    // the original race. `waitFor`, not `findByRole` alone: the role/name
    // query itself already matches the still-disabled element from before
    // `resolveCreate` was awaited, so only re-asserting `not.toBeDisabled()`
    // on every retry actually waits out the re-render.
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Optional title' })).not.toBeDisabled());
  });

  it('removes a deleted row at once and restores it when the DELETE fails', async () => {
    // Held open, not `mockRejectedValue`: an immediately-rejecting promise's
    // microtask chain would also run onError and restore the row before this
    // test ever observes the removed state in between — the DELETE call and
    // its own rejection would land in the same act() flush regardless of
    // whether `holdDelete`'s 1s hold is fast-forwarded under fake timers or
    // waited out for real. Rejecting only after the removal has been
    // asserted reproduces what a real network failure looks like: the
    // optimistic removal renders first, the error (and restore) arrives some
    // time later.
    let reject: (error: unknown) => void = () => {};
    vi.mocked(api.deleteAitoTask).mockImplementation(
      () => new Promise((_resolve, rej) => { reject = rej; }),
    );
    await renderTasks({ projectId: 1, tasks: [makeTask({ id: 10 }), makeTask({ id: 11 })] });

    await holdDelete(0);
    expect(screen.getAllByRole('heading', { level: 4 })).toHaveLength(1);

    reject(new Error('nope'));
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 4 })).toHaveLength(2));
  });

  it('does not refetch the board on a task edit', async () => {
    const client = await renderTasks({ projectId: 1, tasks: [makeTask({ id: 10, scan_cost: 5 })] });
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    await editCost(10, '9');
    await waitFor(() => expect(api.updateAitoTask).toHaveBeenCalled());

    // A cost edit debounces its PATCH but must never invalidate the board —
    // that would be a full-board GET per keystroke, the exact cost the
    // close-time-only refresh (`closedRef`/`inFlightRef`) exists to avoid.
    // This is the regression guard: it would fail the instant an
    // `invalidateQueries(['aito-projects'])` were added to the edit path.
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['aito-projects'] });
  });
});
