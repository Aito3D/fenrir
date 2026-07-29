import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, act, waitFor, render as rtlRender } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { server } from '../mocks/server';
import { render } from '../utils';
import { diffTaskDraft, ProjectDetailPanel } from '../../components/aito/ProjectDetailPanel';
import { ToastProvider } from '../../contexts/ToastContext';
import { api } from '../../api/client';
import type { AitoProject, AitoTask } from '../../api/client';
import { emptyTaskDraft, taskDraftToTaskCreate } from '../../utils/taskDraft';

const project: AitoProject = {
  id: 12,
  description: 'Support de caméra',
  column: 'devis',
  position: 0,
  status: 'active',
  client_id: 'z1',
  client_name: 'ACME SARL',
  client_phone: '+689-87123456',
  client_email: 'hi@acme.pf',
  client_is_company: true,
  quote_id: null,
  quote_number: null,
  quote_date: null,
  quote_total: null,
  quote_url: null,
  quote_salesperson: null,
  quote_status: null,
  quote_sync_state: 'idle',
  quote_sync_error: null,
  created_by: null,
  task_count: 0,
  tasks_total: 0,
  task_services: [],
  move_lock: null,
  created_at: '2026-07-27T00:00:00',
  updated_at: '2026-07-27T00:00:00',
};

const show = (overrides: Partial<AitoProject> = {}) =>
  render(<ProjectDetailPanel project={{ ...project, ...overrides }} onClose={vi.fn()} />);

// Mirrors AitoPage.tsx: `AitoPage` owns the sole `useQuery(['aito-projects'])`
// (AitoPage.tsx:178) and renders `ProjectDetailPanel` as its own child,
// conditionally, via `{expandedProject && <ProjectDetailPanel .../>}`
// (AitoPage.tsx:532-534) — so the board query stays actively observed for the
// panel's entire lifetime; only the panel itself unmounts on close, never the
// page underneath it. `BoardHost` reproduces exactly that shape so the
// board-refresh tests below exercise the real `invalidateQueries` mechanism
// (a genuine HTTP GET the mocked handler can count), not a workaround for the
// test harness lacking an observer. Toggle `showPanel` via `rerender`, not
// `unmount`, to close the panel without also tearing down the board observer
// — unmounting the whole tree would remove both at once and race their
// cleanup order against each other, which is not how production works.
function BoardHost({ showPanel }: { showPanel: boolean }) {
  useQuery({ queryKey: ['aito-projects'], queryFn: api.getAitoProjects });
  return showPanel ? <ProjectDetailPanel project={project} onClose={vi.fn()} /> : null;
}

// ProjectDetailPanel renders TaskEditor unconditionally, and every TaskRow
// renders ImpressionFields, which always queries these three endpoints
// regardless of whether a given test touches Impression3D (mirrors
// TaskEditor.test.tsx / NewProjectModal.test.tsx).
const mockFilaments = [
  {
    id: 1,
    name: 'Sunlu PA6-CF',
    brand: 'Sunlu',
    material: 'PA6-CF',
    cost_per_kg: 3731,
    sale_price_per_kg: 5597,
    difficulty_pct: 150,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

const mockPrinters = [
  {
    id: 1,
    name: 'H2S',
    purchase_price: 347000,
    lifetime_years: 2,
    daily_usage_hours: 5,
    power_watts: 400,
    repair_rate_pct: 30,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

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

const mockTask: AitoTask = {
  id: 101,
  project_id: 12,
  position: 0,
  title: 'Bracket mount',
  description: 'Print in PA6-CF',
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

const mockTask2: AitoTask = {
  ...mockTask,
  id: 102,
  title: 'Second bracket',
};

// A task with a real, resolvable Impression3D service and a frozen cost that
// today's `mockDefaults` would NOT reproduce if recomputed — the same shape
// TaskEditor.test.tsx uses to pin the provenance gate, ported here because no
// committed panel test exercised this path (every other fixture above has
// `impression_cost: null` and no printer/filament, so the gate this guards
// was never actually reached from the panel).
const mockImpressionTask: AitoTask = {
  ...mockTask,
  id: 111,
  impression_printer_id: 1,
  impression_filament_id: 1,
  impression_weight_g: 40,
  impression_time_min: 60,
  impression_quantity: 1,
  impression_color: 'Noir',
  impression_cost: 12345,
};

// Same, but the printer reference is dangling — absent from `mockPrinters`
// (which only has id 1). `impression_printer_id` isn't a foreign key (see
// aito_task.py), so a printer later deleted from the calculator must not
// corrupt a frozen historical quote.
const mockDanglingPrinterTask: AitoTask = {
  ...mockImpressionTask,
  id: 112,
  impression_printer_id: 999,
};

beforeEach(() => {
  server.use(
    http.get('/api/v1/calculator/filaments/', () => HttpResponse.json(mockFilaments)),
    http.get('/api/v1/calculator/printers/', () => HttpResponse.json(mockPrinters)),
    http.get('/api/v1/calculator/defaults', () => HttpResponse.json(mockDefaults)),
    http.get('/api/v1/aito/12/tasks', () => HttpResponse.json([mockTask])),
  );
});

/** Task rows render collapsed, so a test that reaches a field inside one has
 *  to open it first. Only the row toggles carry aria-expanded at this point —
 *  every other expandable control lives inside a row body, which is unmounted
 *  while collapsed. */
async function expandAllTasks() {
  for (const toggle of await screen.findAllByRole('button', { expanded: false })) {
    fireEvent.click(toggle);
  }
}

/** Switches every expanded row into edit mode, revealing the raw
 *  title/description/cost/ImpressionFields form in place of the read-only
 *  step list. The Edit button lives in the row header, not the collapsible
 *  body, so it is present (and clickable) whether or not the row is
 *  expanded — call this only after `expandAllTasks`, which is what actually
 *  mounts the fields these tests go on to touch. Deliberately not used by
 *  tests that click a step's Done toggle: that button lives in the
 *  read-only `TaskStepList`, which edit mode hides. */
async function editAllTasks() {
  for (const button of await screen.findAllByRole('button', { name: /edit task/i })) {
    fireEvent.click(button);
  }
}

describe('ProjectDetailPanel client fields', () => {
  it('titles the panel with the project reference, not the client', () => {
    // level: 2 disambiguates from TaskEditor's "Tasks" <h3> section heading,
    // which now always renders alongside the project title.
    show();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/Project #12|Projet n°12/);
  });

  it('still names the dialog after the client for assistive technology', () => {
    show();
    expect(screen.getByRole('dialog')).toHaveAccessibleName('ACME SARL');
  });

  it('labels a company client as Company name', () => {
    show();
    expect(screen.getByText(/company name/i)).toBeInTheDocument();
    expect(screen.queryByText(/^client name/i)).not.toBeInTheDocument();
  });

  it('labels a person client as Client name', () => {
    show({ client_is_company: false, client_name: 'Paul THEIS' });
    expect(screen.getByText(/client name/i)).toBeInTheDocument();
    expect(screen.queryByText(/company name/i)).not.toBeInTheDocument();
  });

  it('labels a legacy card with a null flag as Client name', () => {
    show({ client_is_company: null });
    expect(screen.getByText(/client name/i)).toBeInTheDocument();
  });

  it('labels the phone and email, and keeps their links', () => {
    show();
    expect(screen.getByText(/phone/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '+689-87123456' })).toHaveAttribute(
      'href',
      'tel:+689-87123456',
    );
    expect(screen.getByRole('link', { name: 'hi@acme.pf' })).toHaveAttribute(
      'href',
      'mailto:hi@acme.pf',
    );
  });

  it('omits a field entirely when it has no value', () => {
    show({ client_email: null });
    expect(screen.queryByText(/email/i)).not.toBeInTheDocument();
  });
});

describe('ProjectDetailPanel tasks', () => {
  it('fetches and renders the project\'s tasks on open', async () => {
    show();

    // Collapsed, the row shows its name as text; the title input only exists
    // once it is open.
    expect(await screen.findByRole('button', { name: /^Bracket mount/ })).toBeInTheDocument();
    await expandAllTasks();
    await editAllTasks();
    expect(screen.getByDisplayValue('Bracket mount')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Print in PA6-CF')).toBeInTheDocument();
    expect(screen.getByLabelText('Scan Cost')).toHaveValue(500);
  });

  it('editing a service cost issues PATCH /aito/tasks/{id} with only that field in the body', async () => {
    let capturedBody: unknown;
    let capturedId: string | undefined;
    server.use(
      http.patch('/api/v1/aito/tasks/:id', async ({ request, params }) => {
        capturedBody = await request.json();
        capturedId = params.id as string;
        return HttpResponse.json({ ...mockTask, scan_cost: 700 });
      }),
    );

    show();
    await expandAllTasks();
    await editAllTasks();
    const scanInput = await screen.findByLabelText('Scan Cost');
    fireEvent.change(scanInput, { target: { value: '700' } });

    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedId).toBe('101');
    expect(capturedBody).toEqual({ scan_cost: 700 });
  });

  it('ticking a step\'s Done toggle issues PATCH /aito/tasks/{id} with only that field in the body', async () => {
    // Guards the wiring `diffTaskDraft` needs for a tick specifically: it is
    // easy to add a cost field to the diff and forget the *_done sibling, in
    // which case the click above does nothing on the wire (see the doc on
    // `diffTaskDraft` in ProjectDetailPanel.tsx).
    let capturedBody: unknown;
    let capturedId: string | undefined;
    server.use(
      http.patch('/api/v1/aito/tasks/:id', async ({ request, params }) => {
        capturedBody = await request.json();
        capturedId = params.id as string;
        return HttpResponse.json({ ...mockTask, scan_done: true });
      }),
    );

    const user = userEvent.setup();
    show();
    await expandAllTasks();

    await user.click(await screen.findByRole('button', { name: /mark done/i }));

    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedId).toBe('101');
    expect(capturedBody).toEqual({ scan_done: true });
  });

  it('refreshes the board immediately when a step is ticked, unlike a plain cost edit', async () => {
    // The panel defers the board refresh to close for per-keystroke cost
    // PATCHes (see `updateTaskMutation`'s doc), but a tick can move the
    // project to a different COLUMN, so it must not wait — the Stage row and
    // the card behind the panel have to move together, while the panel is
    // still open.
    const boardFetches = vi.fn();
    server.use(
      http.get('/api/v1/aito/', () => {
        boardFetches();
        return HttpResponse.json([]);
      }),
      http.patch('/api/v1/aito/tasks/:id', () => HttpResponse.json({ ...mockTask, scan_done: true })),
    );
    const user = userEvent.setup();
    render(<BoardHost showPanel />);

    await waitFor(() => expect(boardFetches).toHaveBeenCalledTimes(1));
    boardFetches.mockClear();

    await expandAllTasks();
    await user.click(await screen.findByRole('button', { name: /mark done/i }));

    await waitFor(() => expect(boardFetches).toHaveBeenCalled());
  });

  it('does not resurrect a step\'s old Done state when the card is reopened', async () => {
    // Production runs a 60s app-wide staleTime (App.tsx), so reopening a card
    // within the minute is served from the `['aito-tasks', id]` cache with no
    // GET. Un-ticking a step advanced the diff baseline and invalidated the
    // BOARD, but left that cache holding the pre-tick rows: the card moved
    // back a column while the very step it moved for still read as done.
    //
    // The shared test client uses staleTime 0, which refetches on every mount
    // and hides this completely — hence a production-shaped client here.
    let stored: AitoTask = { ...mockTask, scan_done: true };
    server.use(
      http.get('/api/v1/aito/12/tasks', () => HttpResponse.json([stored])),
      http.patch('/api/v1/aito/tasks/:id', async ({ request }) => {
        stored = { ...stored, ...((await request.json()) as Partial<AitoTask>) };
        return HttpResponse.json(stored);
      }),
    );

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
    const Host = ({ open }: { open: boolean }) => (
      <QueryClientProvider client={client}>
        <ToastProvider>{open ? <ProjectDetailPanel project={project} onClose={vi.fn()} /> : null}</ToastProvider>
      </QueryClientProvider>
    );

    const user = userEvent.setup();
    const { rerender } = rtlRender(<Host open />);
    await expandAllTasks();
    await user.click(await screen.findByRole('button', { name: /mark not done/i }));
    await waitFor(() => expect(stored.scan_done).toBe(false));

    // Close, then reopen well inside the staleTime window.
    rerender(<Host open={false} />);
    rerender(<Host open />);
    await expandAllTasks();

    expect(await screen.findByRole('button', { name: /mark done/i })).toBeInTheDocument();
  });

  it('editing a value back to its original after a successful save still issues a second PATCH', async () => {
    // Regression: `updateTaskMutation`'s onSuccess must advance `baselineRef`
    // (the diff baseline) for the patched row to the server's response —
    // deliberately outside the `['aito-tasks', project.id]` query cache,
    // which a single-field PATCH must never rewrite (see the comments above
    // `baselineRef` and `updateTaskMutation` in ProjectDetailPanel.tsx: doing
    // so would change that query's data identity and trigger the resync
    // effect, clobbering every other row's unsaved or in-flight edit). If
    // `baselineRef` isn't advanced, it stays frozen at initial load, so
    // reverting a field to its originally-loaded value looks like "no
    // change" against that stale baseline and the second PATCH is silently
    // dropped — the server is left holding the intermediate value with no
    // toast, no indicator.
    const bodies: Record<string, unknown>[] = [];
    let current: AitoTask = { ...mockTask };
    server.use(
      http.patch('/api/v1/aito/tasks/:id', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        bodies.push(body);
        current = { ...current, ...body };
        return HttpResponse.json(current);
      }),
    );

    show();
    await expandAllTasks();
    await editAllTasks();
    const scanInput = await screen.findByLabelText('Scan Cost');

    fireEvent.change(scanInput, { target: { value: '700' } });
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ scan_cost: 700 });

    fireEvent.change(scanInput, { target: { value: '500' } });
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({ scan_cost: 500 });
  });

  it('re-disabling a service after enabling it sends an explicit null, not a dropped patch', async () => {
    // The damaging instance of the same bug: null (disabled) -> 0 (free,
    // saved) -> null (disabled again) must reach the server as two PATCHes,
    // the second carrying an explicit `null`. Silently dropping it leaves
    // the server billing for a service the UI shows as off.
    const noScanTask: AitoTask = { ...mockTask, scan_cost: null };
    const bodies: Record<string, unknown>[] = [];
    let current: AitoTask = { ...noScanTask };
    server.use(
      http.get('/api/v1/aito/12/tasks', () => HttpResponse.json([noScanTask])),
      http.patch('/api/v1/aito/tasks/:id', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        bodies.push(body);
        current = { ...current, ...body };
        return HttpResponse.json(current);
      }),
    );

    show();
    await expandAllTasks();
    await editAllTasks();
    const scanInput = await screen.findByLabelText('Scan Cost');
    expect(scanInput).toHaveValue(null);

    fireEvent.change(scanInput, { target: { value: '0' } });
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ scan_cost: 0 });

    fireEvent.change(scanInput, { target: { value: '' } });
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({ scan_cost: null });
  });

  it('a different row resolving its PATCH does not clobber this row\'s in-flight edit', async () => {
    // Regression for the invariant documented at :144-148: the tasks list
    // must resync from a genuine fetch, never from a single-field PATCH
    // response. Task 101's PATCH is held open; task 102's resolves
    // immediately. If the panel resyncs the *whole* local array whenever
    // any row's PATCH settles (e.g. by writing the response into the
    // ['aito-tasks', project.id] query cache and letting the resync effect
    // react to that), task 101's still-in-flight, not-yet-persisted edit
    // gets overwritten by the stale value from the last real fetch.
    let resolvePatch101: (task: AitoTask) => void = () => {};
    const patch101 = new Promise<AitoTask>((resolve) => {
      resolvePatch101 = resolve;
    });
    server.use(
      http.get('/api/v1/aito/12/tasks', () => HttpResponse.json([mockTask, mockTask2])),
      http.patch('/api/v1/aito/tasks/:id', async ({ request, params }) => {
        const body = (await request.json()) as Record<string, unknown>;
        if ((params.id as string) === '101') {
          const base = await patch101; // held open until the test resolves it
          return HttpResponse.json({ ...base, ...body });
        }
        return HttpResponse.json({ ...mockTask2, ...body });
      }),
    );

    show();
    await expandAllTasks();
    await editAllTasks();
    const scanInputs = await screen.findAllByLabelText('Scan Cost');
    expect(scanInputs).toHaveLength(2);

    // Row 101: edit, PATCH fires but hangs (never resolved in this test).
    fireEvent.change(scanInputs[0], { target: { value: '900' } });
    expect(scanInputs[0]).toHaveValue(900);

    // Row 102: edit, PATCH fires and resolves immediately.
    fireEvent.change(scanInputs[1], { target: { value: '700' } });

    // Give row 102's PATCH (and any resulting cache write / resync effect)
    // time to fully settle.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(scanInputs[1]).toHaveValue(700);

    // Row 101's typed-but-unsaved value must still be showing.
    expect(scanInputs[0]).toHaveValue(900);

    resolvePatch101({ ...mockTask, scan_cost: 900 });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(scanInputs[0]).toHaveValue(900);
  });

  it('editing the title issues a PATCH with only title, sending null (not empty string) when blank', async () => {
    let capturedBody: unknown;
    server.use(
      http.patch('/api/v1/aito/tasks/:id', async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ ...mockTask, title: null });
      }),
    );

    show();
    await expandAllTasks();
    await editAllTasks();
    const titleInput = await screen.findByDisplayValue('Bracket mount');
    fireEvent.change(titleInput, { target: { value: '' } });

    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedBody).toEqual({ title: null });
  });

  it('"Add task" issues POST /aito/{project_id}/tasks', async () => {
    let capturedBody: unknown;
    let posted = false;
    server.use(
      http.post('/api/v1/aito/12/tasks', async ({ request }) => {
        capturedBody = await request.json();
        posted = true;
        return HttpResponse.json({
          ...mockTask,
          id: 202,
          title: null,
          description: null,
          scan_cost: null,
        });
      }),
    );

    const user = userEvent.setup();
    show();
    await screen.findByRole('button', { name: /^Bracket mount/ });

    await user.click(screen.getByRole('button', { name: /add task/i }));

    await waitFor(() => expect(posted).toBe(true));
    expect(capturedBody).toEqual({
      title: null,
      description: null,
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
    });
  });

  it('hold-to-remove issues DELETE /aito/tasks/{id}', async () => {
    let deletedId: string | undefined;
    server.use(
      http.delete('/api/v1/aito/tasks/:id', ({ params }) => {
        deletedId = params.id as string;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    vi.useFakeTimers({ shouldAdvanceTime: true });
    show();
    // The panel fetches tasks asynchronously; flush that under fake timers
    // before looking for the row's remove button.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const removeButton = await screen.findByLabelText('Remove task');

    await act(async () => {
      fireEvent.pointerDown(removeButton);
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(deletedId).toBe('101');
    vi.useRealTimers();
  });

  it('a failed PATCH shows the aito.saveFailed toast and keeps the panel\'s other state', async () => {
    server.use(
      http.patch('/api/v1/aito/tasks/:id', () => HttpResponse.json({ error: 'boom' }, { status: 500 })),
    );

    show();
    await expandAllTasks();
    await editAllTasks();
    const scanInput = await screen.findByLabelText('Scan Cost');
    fireEvent.change(scanInput, { target: { value: '700' } });

    expect(await screen.findByText(/could not save your changes/i)).toBeInTheDocument();

    // The edited value stays on screen (not rolled back), and the rest of the
    // panel — the client details rendered outside TaskEditor — is untouched.
    expect(screen.getByLabelText('Scan Cost')).toHaveValue(700);
    expect(screen.getByText('ACME SARL')).toBeInTheDocument();
  });

  it('opening a task with a stored impression cost and valid printer/filament references, touching nothing, issues zero PATCHes', async () => {
    // The Critical this whole feature round revolved around: merely opening
    // the panel must never recompute and PATCH a frozen, real quote. No
    // committed panel test reached this path before — every fixture above
    // has `impression_cost: null` and no printer/filament, so ImpressionFields
    // never had a resolvable Impression3D service to recompute in the first
    // place.
    let patched = false;
    server.use(
      http.get('/api/v1/aito/12/tasks', () => HttpResponse.json([mockImpressionTask])),
      http.patch('/api/v1/aito/tasks/:id', () => {
        patched = true;
        return HttpResponse.json(mockImpressionTask);
      }),
    );

    show();
    // Opening the row is the scenario under test: the user expands a task,
    // sees its stored quote, and touches nothing.
    await expandAllTasks();
    await editAllTasks();

    // Give every query (filaments, printers, defaults, settings, tasks)
    // every chance to resolve. Pricing only happens inside ImpressionFields'
    // change handler now, so mounting alone should never PATCH anything —
    // this window is here to be sure nothing async sneaks in after mount.
    await screen.findByRole('combobox', { name: /printer/i });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(patched).toBe(false);
  });

  it('opening a task whose printer reference is dangling (absent from the calculator list) issues zero PATCHes', async () => {
    let patched = false;
    server.use(
      http.get('/api/v1/aito/12/tasks', () => HttpResponse.json([mockDanglingPrinterTask])),
      http.patch('/api/v1/aito/tasks/:id', () => {
        patched = true;
        return HttpResponse.json(mockDanglingPrinterTask);
      }),
    );

    show();
    // Opening the row is the scenario under test.
    await expandAllTasks();
    await editAllTasks();

    await screen.findByRole('combobox', { name: /material/i });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(patched).toBe(false);
  });

  it('editing one row then deleting it does not leak its edited state onto the row that slides into its slot', async () => {
    // The residual this file exists to close: TaskEditor used to key rows by
    // array index. Editing row A's print inputs types into the
    // ImpressionFields instance mounted at index 0; hold-deleting row A then
    // slides row B up into index 0, and with an index key React reuses that
    // same mounted instance — DOM nodes and all — for row B's data instead of
    // remounting it. B's untouched, frozen `impression_cost` then gets
    // recomputed from leftover row-A state and PATCHed over the stored figure
    // despite nobody ever having touched B.
    const patches: { id: string; body: Record<string, unknown> }[] = [];
    let currentTasks: AitoTask[] = [mockTask, mockImpressionTask];
    server.use(
      http.get('/api/v1/aito/12/tasks', () => HttpResponse.json(currentTasks)),
      http.delete('/api/v1/aito/tasks/:id', ({ params }) => {
        currentTasks = currentTasks.filter((t) => String(t.id) !== (params.id as string));
        return new HttpResponse(null, { status: 204 });
      }),
      http.patch('/api/v1/aito/tasks/:id', async ({ request, params }) => {
        const body = (await request.json()) as Record<string, unknown>;
        patches.push({ id: params.id as string, body });
        return HttpResponse.json({ ...mockTask, ...body });
      }),
    );

    vi.useFakeTimers({ shouldAdvanceTime: true });
    show();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Row A (task 101, index 0): edit a print input on the ImpressionFields
    // instance mounted at index 0.
    await expandAllTasks();
    await editAllTasks();
    const weightInputs = await screen.findAllByLabelText(/weight/i);
    expect(weightInputs).toHaveLength(2);
    fireEvent.change(weightInputs[0], { target: { value: '40' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Hold-delete row A. Its removal triggers a refetch that resyncs `tasks`
    // to just [task 111] — sliding row B (task 111, the surviving row) up
    // into index 0, the slot row A's instance just vacated.
    const removeButtons = screen.getAllByLabelText('Remove task');
    await act(async () => {
      fireEvent.pointerDown(removeButtons[0]);
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Row B is now the only row, showing its own (untouched) data.
    await screen.findByDisplayValue('Bracket mount');

    vi.useRealTimers();

    // Any PATCH row A's own weight edit produced is for id 101 and is
    // irrelevant here — the row itself is gone. The assertion is that the
    // surviving row, task 111, never gets patched.
    expect(patches.some((p) => p.id === '111')).toBe(false);
  });

  it('refreshes the board when a task is added', async () => {
    const boardFetches = vi.fn();
    server.use(
      http.get('/api/v1/aito/', () => {
        boardFetches();
        return HttpResponse.json([]);
      }),
      http.post('/api/v1/aito/12/tasks', () =>
        HttpResponse.json({ ...mockTask, id: 99 }, { status: 201 }),
      ),
    );
    const user = userEvent.setup();
    render(<BoardHost showPanel />);

    // BoardHost's own mount fetches the board once; wait for it to settle and
    // clear it so the assertion below is about the *add*, not the mount.
    await waitFor(() => expect(boardFetches).toHaveBeenCalledTimes(1));
    boardFetches.mockClear();

    await user.click(await screen.findByRole('button', { name: /add task/i }));
    await waitFor(() => expect(boardFetches).toHaveBeenCalled());
  });

  it('refreshes the board when a task is removed', async () => {
    const boardFetches = vi.fn();
    server.use(
      http.get('/api/v1/aito/', () => {
        boardFetches();
        return HttpResponse.json([]);
      }),
      http.delete('/api/v1/aito/tasks/:id', () => new HttpResponse(null, { status: 204 })),
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<BoardHost showPanel />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await waitFor(() => expect(boardFetches).toHaveBeenCalledTimes(1));
    boardFetches.mockClear();

    const removeButton = await screen.findByLabelText('Remove task');
    await act(async () => {
      fireEvent.pointerDown(removeButton);
      await vi.advanceTimersByTimeAsync(1000);
    });

    await waitFor(() => expect(boardFetches).toHaveBeenCalled());
    vi.useRealTimers();
  });

  it('refreshes the board on close after a task field was edited', async () => {
    const boardFetches = vi.fn();
    const patches: Record<string, unknown>[] = [];
    server.use(
      http.get('/api/v1/aito/', () => {
        boardFetches();
        return HttpResponse.json([]);
      }),
      http.patch('/api/v1/aito/tasks/:id', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        patches.push(body);
        return HttpResponse.json({ ...mockTask, ...body });
      }),
    );
    const user = userEvent.setup();
    const { rerender } = render(<BoardHost showPanel />);

    await waitFor(() => expect(boardFetches).toHaveBeenCalledTimes(1));

    await expandAllTasks();
    await editAllTasks();
    const scan = await screen.findByLabelText('Scan Cost');
    await user.clear(scan);
    await user.type(scan, '500');
    await waitFor(() => expect(screen.getByLabelText('Scan Cost')).toHaveValue(500));

    // Await the write, not just the input's value: the value is local state
    // and is set before the PATCH it triggers has been sent, let alone
    // answered. Typing sends one PATCH per keystroke (null, 5, 50, 500), and
    // closing while any of them is open is the deferral's other branch, tested
    // separately below — this test is about the everything-has-landed path, so
    // it waits for the last body to arrive and for its response to be applied.
    await waitFor(() => expect(patches.at(-1)).toEqual({ scan_cost: 500 }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    boardFetches.mockClear();
    // Close only the panel — BoardHost (standing in for AitoPage) stays
    // mounted, exactly as it does in production, so its ['aito-projects']
    // observer is still there to receive the invalidation.
    rerender(<BoardHost showPanel={false} />);
    await waitFor(() => expect(boardFetches).toHaveBeenCalled());
  });

  it('closing with a PATCH still in flight waits for it before refreshing the board', async () => {
    // Race the "refresh once, on close" deferral used to lose. Task fields
    // PATCH per keystroke, so typing `4000` fires four of them; an earlier one
    // has already landed (the panel is "dirty") while a later one is still
    // open when the user closes. Invalidating on the dirty flag alone fires
    // the board GET concurrently with that open PATCH, with no ordering
    // guarantee — served first, the GET writes a pre-PATCH total into the
    // card, and staleTime (60s, App.tsx) means nothing corrects it.
    const boardFetches = vi.fn();
    const bodies: Record<string, unknown>[] = [];
    let releaseSecondPatch: (task: AitoTask) => void = () => {};
    const secondPatch = new Promise<AitoTask>((resolve) => {
      releaseSecondPatch = resolve;
    });
    server.use(
      http.get('/api/v1/aito/', () => {
        boardFetches();
        return HttpResponse.json([]);
      }),
      http.patch('/api/v1/aito/tasks/:id', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        bodies.push(body);
        if (bodies.length === 1) return HttpResponse.json({ ...mockTask, ...body });
        const base = await secondPatch; // held open until this test releases it
        return HttpResponse.json({ ...base, ...body });
      }),
    );
    const { rerender } = render(<BoardHost showPanel />);
    await waitFor(() => expect(boardFetches).toHaveBeenCalledTimes(1));

    await expandAllTasks();
    await editAllTasks();
    const scan = await screen.findByLabelText('Scan Cost');

    // Keystroke 1: PATCH fires and lands, so the panel is now dirty.
    fireEvent.change(scan, { target: { value: '700' } });
    await waitFor(() => expect(bodies).toHaveLength(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Keystroke 2: PATCH fires and stays open.
    fireEvent.change(scan, { target: { value: '900' } });
    await waitFor(() => expect(bodies).toHaveLength(2));

    boardFetches.mockClear();
    rerender(<BoardHost showPanel={false} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    // The write this refresh is meant to reflect has not landed yet.
    expect(boardFetches).not.toHaveBeenCalled();

    releaseSecondPatch({ ...mockTask, scan_cost: 900 });
    await waitFor(() => expect(boardFetches).toHaveBeenCalled());
  });

  it('refreshes the board when the only PATCH lands after the panel already closed', async () => {
    // The mirror case: one keystroke, closed before its PATCH returns. Nothing
    // has been saved at unmount, so a dirty-flag-only trigger never fires at
    // all and the card keeps its pre-edit total until something else
    // invalidates the board. The late-landing write must still refresh it.
    const boardFetches = vi.fn();
    const bodies: Record<string, unknown>[] = [];
    let releasePatch: (task: AitoTask) => void = () => {};
    const heldPatch = new Promise<AitoTask>((resolve) => {
      releasePatch = resolve;
    });
    server.use(
      http.get('/api/v1/aito/', () => {
        boardFetches();
        return HttpResponse.json([]);
      }),
      http.patch('/api/v1/aito/tasks/:id', async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(await heldPatch);
      }),
    );
    const { rerender } = render(<BoardHost showPanel />);
    await waitFor(() => expect(boardFetches).toHaveBeenCalledTimes(1));

    await expandAllTasks();
    await editAllTasks();
    const scan = await screen.findByLabelText('Scan Cost');
    fireEvent.change(scan, { target: { value: '700' } });
    await waitFor(() => expect(bodies).toHaveLength(1));

    boardFetches.mockClear();
    rerender(<BoardHost showPanel={false} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(boardFetches).not.toHaveBeenCalled();

    releasePatch({ ...mockTask, scan_cost: 700 });
    await waitFor(() => expect(boardFetches).toHaveBeenCalled());
  });

  it('does NOT refresh the board on close when no task was edited', async () => {
    const boardFetches = vi.fn();
    server.use(
      http.get('/api/v1/aito/', () => {
        boardFetches();
        return HttpResponse.json([]);
      }),
    );
    const { rerender } = render(<BoardHost showPanel />);
    await screen.findByText('Support de caméra');
    await waitFor(() => expect(boardFetches).toHaveBeenCalledTimes(1));

    boardFetches.mockClear();
    rerender(<BoardHost showPanel={false} />);
    // Give an invalidation a chance to land before asserting its absence.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(boardFetches).not.toHaveBeenCalled();
  });
});

describe('ProjectDetailPanel quote row', () => {
  it('right-aligns the metadata values', () => {
    show();
    const value = screen.getByText('ACME SARL');
    expect(value.className).toContain('text-right');
  });

  it('shows nothing about a quote on a manually created project', () => {
    show();
    expect(document.querySelector('a[href*="books.zoho"]')).toBeNull();
  });

  it('links an imported project to its quote in Zoho Books', () => {
    show({
      quote_id: 'e2',
      quote_number: 'DEV26-2462',
      quote_date: '2026-07-28',
      quote_total: 5600,
      quote_url: 'https://books.zoho.eu/app/999#/estimates/e2',
    });
    const link = screen.getByRole('link', { name: /DEV26-2462/ });
    expect(link).toHaveAttribute('href', 'https://books.zoho.eu/app/999#/estimates/e2');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('labels the description field', async () => {
    show();
    expect(await screen.findByText('Product description')).toBeInTheDocument();
  });

  it('shows the seller and the creator', async () => {
    show({ quote_number: 'DEV26-2462', quote_salesperson: 'Marie VENDEUSE', created_by: 'paul' });
    expect(await screen.findByText('Marie VENDEUSE')).toBeInTheDocument();
    expect(screen.getByText('paul')).toBeInTheDocument();
  });

  it('omits the seller row entirely when the project has no seller', async () => {
    // An empty "Seller:" is noise, not information — the same rule the phone
    // and email rows follow. Created by is different: it renders an em dash,
    // because "nobody is recorded" is itself worth stating for a card that
    // predates the column or was made with auth off.
    show({ quote_number: 'DEV26-2462', quote_salesperson: null, created_by: null });
    await screen.findByText('DEV26-2462');
    expect(screen.queryByText('Seller:')).not.toBeInTheDocument();
    expect(screen.getByText('Created by:')).toBeInTheDocument();
  });
});

describe('ProjectDetailPanel sync row', () => {
  it('shows no sync row at all for an idle project', async () => {
    // Idle is the normal case for the overwhelming majority of cards; a row
    // reading "up to date" on every single one would be noise, not
    // information — the opposite of the omission rule the seller row above
    // follows.
    show({ quote_sync_state: 'idle' });
    await screen.findByText('ACME SARL');
    expect(screen.queryByText('Sync:')).not.toBeInTheDocument();
  });

  it('shows the pending label while the worker has not caught up yet', async () => {
    show({ quote_sync_state: 'pending' });
    expect(await screen.findByText('Pending')).toBeInTheDocument();
  });

  it('shows the push error and a retry control', async () => {
    show({ quote_sync_state: 'error', quote_sync_error: 'Zoho: invalid customer_id' });
    expect(await screen.findByText('Sync failed')).toBeInTheDocument();
    expect(screen.getByText('Zoho: invalid customer_id')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('shows the locked help text and no retry control once the quote is invoiced', async () => {
    show({ quote_sync_state: 'locked' });
    expect(await screen.findByText('Quote invoiced')).toBeInTheDocument();
    expect(
      screen.getByText('This quote has been invoiced: changes stay local.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('shows a note that Zoho refuses to revert a declined quote to draft', async () => {
    show({ quote_sync_state: 'error', quote_sync_error: 'boom', quote_status: 'declined' });
    expect(
      await screen.findByText('Zoho does not allow reverting a quote back to draft.'),
    ).toBeInTheDocument();
  });

  it('retrying re-saves the unchanged description, which is what re-marks the project pending', async () => {
    // There is deliberately no dedicated retry endpoint — see _mark_pending in
    // api/routes/aito.py, which every content PATCH handler calls. Re-saving
    // the description unchanged IS the retry.
    let capturedBody: unknown;
    server.use(
      http.patch('/api/v1/aito/12', async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ ...project, quote_sync_state: 'pending', quote_sync_error: null });
      }),
    );

    const user = userEvent.setup();
    show({ quote_sync_state: 'error', quote_sync_error: 'Zoho: invalid customer_id' });
    await user.click(await screen.findByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(capturedBody).toEqual({ description: project.description }));
  });
});

describe('diffTaskDraft', () => {
  it('returns an empty patch for an unchanged draft', () => {
    const draft = { ...emptyTaskDraft(), title: 'x', scanCost: 10 };
    expect(diffTaskDraft(draft, draft)).toEqual({});
  });

  it('includes only the fields that changed', () => {
    const before = { ...emptyTaskDraft(), title: 'x', scanCost: 10 };
    const after = { ...before, scanCost: 20 };
    expect(diffTaskDraft(before, after)).toEqual({ scan_cost: 20 });
  });

  it('carries a cost cleared to null', () => {
    const before = { ...emptyTaskDraft(), scanCost: 10 };
    const after = { ...before, scanCost: null };
    expect(diffTaskDraft(before, after)).toEqual({ scan_cost: null });
  });

  it('carries a zero cost, which is free rather than absent', () => {
    const before = emptyTaskDraft();
    const after = { ...before, scanCost: 0 };
    expect(diffTaskDraft(before, after)).toEqual({ scan_cost: 0 });
  });

  it('covers every field of the wire shape', () => {
    // The regression guard for the old hand-written version: a field added to
    // taskDraftToTaskCreate but forgotten in the diff would silently never
    // save. Every key of the wire shape must be diffable.
    //
    // TaskDraft's four step flags are not their own top-level properties —
    // they live under `done: { scan, modelisation, impression, usinage }`
    // (see TaskDraft in utils/taskDraft.ts) — so all four are flipped there,
    // not as scanDone/modelisationDone/impressionDone/usinageDone.
    const before = emptyTaskDraft();
    const after: typeof before = {
      ...before,
      title: 'T',
      description: 'D',
      scanCost: 1,
      modelisationCost: 2,
      usinageCost: 3,
      impressionCost: 4,
      done: { scan: true, modelisation: true, impression: true, usinage: true },
      impression: {
        printerId: 1,
        filamentId: 2,
        weightG: 3,
        timeMin: 4,
        quantity: 5,
        color: 'Noir',
      },
    };
    const patch = diffTaskDraft(before, after);
    const wireKeys = Object.keys(taskDraftToTaskCreate(after));
    expect(Object.keys(patch).sort()).toEqual(wireKeys.sort());
  });
});
