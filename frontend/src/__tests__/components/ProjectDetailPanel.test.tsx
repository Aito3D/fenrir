import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, act, waitFor, within, render as rtlRender } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { server } from '../mocks/server';
import { render } from '../utils';
import { ProjectDetailPanel } from '../../components/aito/ProjectDetailPanel';
import { diffTaskDraft } from '../../hooks/useProjectTasks';
import { ToastProvider } from '../../contexts/ToastContext';
import { api } from '../../api/client';
import type { AitoEvent, AitoProject, AitoTask } from '../../api/client';
import { emptyTaskDraft, taskDraftToTaskCreate } from '../../utils/taskDraft';
import { formatMoney } from '../../utils/pricing';
import { parseUTCDate } from '../../utils/date';
import i18n from '../../i18n';

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

const show = (overrides: Partial<AitoProject> = {}) =>
  render(<ProjectDetailPanel project={{ ...project, ...overrides }} onClose={vi.fn()} onDelete={vi.fn()} />);

// Mirrors AitoPage.tsx: `AitoPage` owns a `useQuery(['aito-projects'])`
// (AitoPage.tsx:83) — no longer the only one in production; `QuoteCombobox`
// also observes this key to mark already-imported quotes in its picker — and
// renders `ProjectDetailPanel` as its own child,
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
function BoardHost({ showPanel, project: projectOverride }: { showPanel: boolean; project?: AitoProject }) {
  useQuery({ queryKey: ['aito-projects'], queryFn: api.getAitoProjects });
  return showPanel ? (
    <ProjectDetailPanel project={projectOverride ?? project} onClose={vi.fn()} onDelete={vi.fn()} />
  ) : null;
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
  scan_description: 'Print in PA6-CF',
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

// A single event standing in for the project's timeline, used by the Record
// card's "last activity" tests to prove it reads occurred_at + actor_name
// from the newest EVENT rather than the project's own updated_at.
const mockEvent: AitoEvent = {
  id: 501,
  occurred_at: '2026-07-29T10:15:00',
  occurred_until: null,
  kind: 'note',
  actor_class: 'user',
  actor_name: 'admin',
  subject_type: null,
  subject_id: null,
  subject_label: null,
  changes: null,
  detail: null,
  note: null,
};

beforeEach(() => {
  server.use(
    http.get('/api/v1/calculator/filaments/', () => HttpResponse.json(mockFilaments)),
    http.get('/api/v1/calculator/printers/', () => HttpResponse.json(mockPrinters)),
    http.get('/api/v1/calculator/defaults', () => HttpResponse.json(mockDefaults)),
    http.get('/api/v1/aito/12/tasks', () => HttpResponse.json([mockTask])),
  );
});

/** Switches every row into edit mode, revealing the raw
 *  title/description/cost/ImpressionFields form in place of the read-only
 *  step list. Rows render open (Task 17 — no disclosure left to click first).
 *  Deliberately not used by tests that click a step's Done toggle: that
 *  button lives in the read-only `TaskStepList`, which edit mode hides. */
async function editAllTasks() {
  for (const button of await screen.findAllByRole('button', { name: /edit task/i })) {
    fireEvent.click(button);
  }
}

describe('ProjectDetailPanel client fields', () => {
  it('titles the panel with the client, and keeps the project reference as its eyebrow', () => {
    // level: 2 disambiguates from TaskEditor's "Tasks" <h3> section heading,
    // which now always renders alongside the project title.
    show();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('ACME SARL');
    expect(screen.getByText(/Project #12|Projet n°12/)).toBeInTheDocument();
  });

  it('falls back to the no-client label when the card has none', () => {
    show({ client_name: null });
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/no client/i);
  });

  it('still names the dialog after the client for assistive technology', () => {
    show();
    expect(screen.getByRole('dialog')).toHaveAccessibleName('ACME SARL');
  });

  it('weights the header ring by money rather than by step count', async () => {
    // 3 500 of 18 000 done is 1 of 3 steps: 19%, not 33%. The three costs
    // below land in three different STAGES groups (scan / model / print), so
    // each contributes exactly one step to stagesWithWork's stepsTotal —
    // giving "1 of 3 steps" done while only 19% of the money is done.
    server.use(
      http.get('/api/v1/aito/12/tasks', () =>
        HttpResponse.json([
          {
            ...mockTask,
            scan_cost: 3500,
            scan_done: true,
            modelisation_cost: 7000,
            modelisation_done: false,
            usinage_cost: 7500,
            usinage_done: false,
          },
        ]),
      ),
    );
    show();
    // The ring renders immediately at 0/0 — before the tasks fetch resolves —
    // so the assertion itself has to be the thing waited on, not just the
    // node's presence.
    await waitFor(() => expect(screen.getByTestId('panel-value-ring')).toHaveAttribute('aria-valuenow', '3500'));
    expect(screen.getByTestId('panel-value-ring')).toHaveAttribute('aria-valuemax', '18000');
  });

  it('gives the ring the same formatted amount the visible caption shows', async () => {
    // Regression: the ring's aria-label used to interpolate the raw number
    // (`t('aito.amountDone', { amount: `${done}` })`) while the caption right
    // beside it used formatMoney — "3500 done" next to "$3,500.00 done".
    // Screen-reader and sighted users must be told the same figure.
    server.use(
      http.get('/api/v1/aito/12/tasks', () => HttpResponse.json([{ ...mockTask, scan_cost: 3500, scan_done: true }])),
    );
    show();
    await waitFor(() => expect(screen.getByTestId('panel-value-ring')).toHaveAttribute('aria-valuenow', '3500'));
    const ring = screen.getByTestId('panel-value-ring');
    expect(ring.getAttribute('aria-label')).toContain(formatMoney(3500, 'USD'));
    // The old label had no currency symbol and no thousands separator — this
    // fails against the raw-number regression directly, not just by omission.
    expect(ring.getAttribute('aria-label')).not.toContain('3500 ');
  });

  it('sources both halves of the header caption from the same tally', async () => {
    // project.steps_done/steps_total are server board fields and lag behind a
    // local tick; stagesWithWork(tasks) is local and updates immediately.
    // The fixture below leaves steps_done/steps_total at the default 0/0
    // while giving stagesWithWork three real steps, one of them done — if the
    // step count still came from the stale project fields, this would read
    // "0/3 steps" (or "0/0") while the money reads one third done.
    server.use(
      http.get('/api/v1/aito/12/tasks', () =>
        HttpResponse.json([
          {
            ...mockTask,
            scan_cost: 3500,
            scan_done: true,
            modelisation_cost: 7000,
            modelisation_done: false,
            usinage_cost: 7500,
            usinage_done: false,
          },
        ]),
      ),
    );
    show({ steps_done: 0, steps_total: 0 });
    await waitFor(() => expect(screen.getByTestId('panel-value-ring')).toHaveAttribute('aria-valuenow', '3500'));
    // Scoped to the header's own caption — TaskEditor's row-level step count
    // ("Bracket mount 1/3 steps") coincidentally reads the same digits, so an
    // unscoped text query would pass whether or not the header itself agreed.
    expect(screen.getByTestId('panel-header-caption')).toHaveTextContent(/1\/3 steps|1\/3 étapes/);
  });

  it('copies the phone and email rather than dialling them', async () => {
    // They used to be `tel:` / `mailto:` links, which hand the value to
    // whatever application claimed the protocol. On a shop machine that is
    // usually nothing; what the value is for is pasting.
    // userEvent installs its own working clipboard, so this exercises the real
    // `copyTextToClipboard` end to end and reads back what actually landed —
    // no writeText spy to drift from the behaviour. The secure-context flag is
    // what routes it down the modern branch; the plain-HTTP fallback has its
    // own coverage in PrinterInfoModal.test.tsx.
    const secure = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });

    try {
      const user = userEvent.setup();
      show();
      expect(screen.queryByRole('link', { name: '+689-87123456' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'hi@acme.pf' })).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /\+689-87123456/ }));
      expect(await navigator.clipboard.readText()).toBe('+689-87123456');

      await user.click(screen.getByRole('button', { name: /hi@acme\.pf/ }));
      expect(await navigator.clipboard.readText()).toBe('hi@acme.pf');
    } finally {
      if (secure) Object.defineProperty(window, 'isSecureContext', secure);
    }
  });

  it('omits a field entirely when it has no value', () => {
    // The "Email" label moved into the CopyableValue button's aria-label
    // during the redesign, so queryByText(/email/i) matches no text node
    // whether or not the field renders — assert on the copy button's
    // accessible name (which embeds the address) instead.
    show({ client_email: null });
    expect(screen.queryByRole('button', { name: /hi@acme\.pf/i })).not.toBeInTheDocument();
  });
});

describe('ProjectDetailPanel tasks', () => {
  it('fetches and renders the project\'s tasks on open', async () => {
    show();

    // Read-only, the row shows its name as a heading; the title input only
    // exists once Edit is pressed.
    expect(await screen.findByRole('heading', { name: /^Bracket mount/ })).toBeInTheDocument();
    await editAllTasks();
    expect(screen.getByDisplayValue('Bracket mount')).toBeInTheDocument();
    // Description is per-service now — mockTask's note lives on the scan
    // block (scan is its only priced step), not a task-level field.
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
    show({ quote_status: 'accepted' });

    await user.click(await screen.findByRole('button', { name: /Scan/i }));

    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedId).toBe('101');
    expect(capturedBody).toEqual({ scan_done: true });
  });

  it('refreshes the board immediately when a step is ticked, unlike a plain cost edit', async () => {
    // The panel defers the board refresh to close for a debounced cost PATCH
    // (see `updateTaskMutation`'s doc), but a tick can move the
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
    render(<BoardHost showPanel project={{ ...project, quote_status: 'accepted' }} />);

    await waitFor(() => expect(boardFetches).toHaveBeenCalledTimes(1));
    boardFetches.mockClear();

    await user.click(await screen.findByRole('button', { name: /Scan/i }));

    await waitFor(() => expect(boardFetches).toHaveBeenCalled());
  });

  it('debounces a task-field edit for the full 500ms window, and refetches neither the mutation nor the board before it elapses', async () => {
    // Regression for a dead debounce: ProjectDetailPanel used to wire
    // `markClosed` straight into a `useEffect` dependency array —
    // `useEffect(() => markClosed, [markClosed])`. `markClosed` closes over
    // React Query's `useMutation` object, which is a fresh identity every
    // render, so the effect re-ran on every render and its cleanup (which
    // *is* `markClosed`) fired after every render instead of only on
    // unmount. In production that meant one PATCH per keystroke — the
    // 500ms window never got a chance to elapse — and, because `closedRef`
    // got stamped `true` from the very first render, every completed save
    // also invalidated the board. A fix that merely restores the eventual
    // PATCH (without restoring its *timing*) still passes every other test
    // in this file, since they all use `waitFor`'s default 1000ms timeout,
    // which a working 500ms debounce satisfies too — only asserting the
    // call count *before* the timer advances catches the dead debounce.
    const boardFetches = vi.fn();
    server.use(
      http.get('/api/v1/aito/', () => {
        boardFetches();
        return HttpResponse.json([]);
      }),
    );
    const updateSpy = vi.spyOn(api, 'updateAitoTask').mockResolvedValue({ ...mockTask, scan_cost: 700 });

    // The mocked `api.updateAitoTask` and fake timers must be torn down even
    // if an assertion below throws — `afterEach` in setup.ts does not call
    // `restoreAllMocks` / `useRealTimers`, so an early failure here would
    // otherwise leak both into the other 40+ tests in this file, turning one
    // failure into a cascade of unrelated-looking ones.
    try {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      render(<BoardHost showPanel />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await waitFor(() => expect(boardFetches).toHaveBeenCalledTimes(1));
      boardFetches.mockClear();

      await editAllTasks();
      const scanInput = await screen.findByLabelText('Scan Cost');

      fireEvent.change(scanInput, { target: { value: '700' } });

      // Give React a chance to re-render and run any effects the edit
      // triggered — exactly the window in which a debounce whose cleanup
      // fires on every render (rather than only on unmount) would flush
      // immediately instead of waiting out the timer.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(updateSpy).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(updateSpy).toHaveBeenCalledWith(101, { scan_cost: 700 });

      // Let onSuccess/onSettled run.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // A plain cost edit defers the board refresh to close (see
      // `updateTaskMutation`'s doc in useProjectTasks.ts) — the panel is still
      // open here, so no board GET must have fired yet. The corrupted
      // `closedRef` (stamped `true` from mount by the same bug) made every
      // completed save look like a post-close settle and fire this GET after
      // every debounced save; the existing board-refetch tests below all
      // `mockClear()` after their edits land, so that spurious GET was
      // invisible to them.
      expect(boardFetches).not.toHaveBeenCalled();
    } finally {
      updateSpy.mockRestore();
      vi.useRealTimers();
    }
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
    const acceptedProject: AitoProject = { ...project, quote_status: 'accepted' };
    const Host = ({ open }: { open: boolean }) => (
      <QueryClientProvider client={client}>
        <ToastProvider>{open ? <ProjectDetailPanel project={acceptedProject} onClose={vi.fn()} onDelete={vi.fn()} /> : null}</ToastProvider>
      </QueryClientProvider>
    );

    const user = userEvent.setup();
    const { rerender } = rtlRender(<Host open />);
    await user.click(await screen.findByRole('button', { name: /Scan/i }));
    await waitFor(() => expect(stored.scan_done).toBe(false));

    // Close, then reopen well inside the staleTime window.
    rerender(<Host open={false} />);
    rerender(<Host open />);

    // The button's accessible name no longer encodes state (that moved to
    // aria-pressed, see Task 5), so this needs its own `waitFor`: the
    // element is found the instant it first renders, even mid-resync, and
    // only the (possibly still-stale) attribute read afterwards proves the
    // resync actually finished with the fresh, un-resurrected value.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Scan/i })).toHaveAttribute('aria-pressed', 'false'),
    );
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
    // The task starts with every service null — stepless, so it is already
    // showing its form (no Edit press needed, and no pencil to press: see
    // TaskRow, which hides the toggle when there is no other mode to switch
    // to). Every service is still a chip, though: enable Scan to reach its
    // cost input — enabling must not itself invent a price.
    await userEvent.click(await screen.findByRole('button', { name: 'Add Scan' }));
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
          scan_cost: null,
        });
      }),
    );

    const user = userEvent.setup();
    show();
    await screen.findByRole('heading', { name: /^Bracket mount/ });

    await user.click(screen.getByRole('button', { name: /add task/i }));

    await waitFor(() => expect(posted).toBe(true));
    expect(capturedBody).toEqual({
      title: null,
      scan_description: null,
      modelisation_description: null,
      impression_description: null,
      usinage_description: null,
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
      impression_discount_pct: null,
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
    // Opening the row's edit form is the scenario under test: the user
    // presses Edit, sees the task's stored quote, and touches nothing.
    await editAllTasks();
    // The calculator opens closed (its fields hide behind the toggle);
    // opening it is a disclosure click, not an edit — still zero PATCHes.
    fireEvent.click(await screen.findByRole('button', { name: 'Calculator' }));

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
    // Opening the row's edit form is the scenario under test.
    await editAllTasks();
    fireEvent.click(await screen.findByRole('button', { name: 'Calculator' }));

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
    // instance mounted at index 0. Row A's own impressionCost is null (only
    // its scanCost is priced), so Printing is still a chip there — row B
    // (mockImpressionTask) already has a priced Printing service, so its
    // chip is on and its button reads "Remove Printing" instead, leaving
    // "Add Printing" unique to row A.
    await editAllTasks();
    fireEvent.click(await screen.findByRole('button', { name: 'Add Printing' }));
    // Both rows' calculators start closed; open them to reach the weight
    // inputs the leak scenario types into.
    for (const toggle of await screen.findAllByRole('button', { name: 'Calculator' })) fireEvent.click(toggle);
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

    await editAllTasks();
    const scan = await screen.findByLabelText('Scan Cost');
    await user.clear(scan);
    // 700, not mockTask's own baseline (500): typing back to the persisted
    // value would legitimately diff to an empty patch and send nothing (see
    // "editing a value back to its original..." below), which would make
    // this test about that edge case instead of the everything-has-landed
    // path it is meant to cover.
    await user.type(scan, '700');
    await waitFor(() => expect(screen.getByLabelText('Scan Cost')).toHaveValue(700));

    // Await the write, not just the input's value: the value is local state
    // and is set before the PATCH it triggers has been sent, let alone
    // answered. The debounce coalesces the whole keystroke burst (7, 70,
    // 700) into one PATCH, sent DEBOUNCE_MS after the last keystroke —
    // closing before that timer elapses is the deferral's other branch,
    // tested separately below — this test is about the everything-has-landed
    // path, so it waits for the body to arrive and for its response to be
    // applied.
    await waitFor(() => expect(patches.at(-1)).toEqual({ scan_cost: 700 }));
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
    // Race the "refresh once, on close" deferral used to lose. Cost edits are
    // debounced (500ms), not sent per keystroke, so this test edits the field
    // twice: the first edit's PATCH is awaited until it lands (the panel is
    // now "dirty"), then the second edit fires and its PATCH is still open
    // when the user closes. Invalidating on the dirty flag alone fires
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

  it('does not resurrect the pre-edit cost when the card is reopened after a PATCH that lands post-close', async () => {
    // Regression for the narrower fix that shipped alongside the debounce:
    // `onSettled` invalidates BOTH ['aito-tasks', projectId] and
    // ['aito-projects'] (see useProjectTasks.ts), because with the app-wide
    // 60s staleTime a card reopened inside that window is served straight
    // from the tasks cache. The sibling test above ("...lands after the
    // panel already closed") only counts board GETs, so it would stay green
    // even if the tasks half of that invalidation were narrowed back out —
    // it can't see the tasks cache going stale.
    //
    // This is the "does not resurrect a step's old Done state" test's setup
    // (production-shaped client, 60s staleTime, close-then-reopen within the
    // window), but with the PATCH still in flight at close time, so the
    // invalidation runs from the mutation's own `onSettled` (closedRef
    // already true) rather than the unmount-cleanup branch the Done-state
    // test exercises.
    let stored: AitoTask = { ...mockTask };
    let releasePatch: (task: AitoTask) => void = () => {};
    const heldPatch = new Promise<AitoTask>((resolve) => {
      releasePatch = resolve;
    });
    server.use(
      http.get('/api/v1/aito/12/tasks', () => HttpResponse.json([stored])),
      http.patch('/api/v1/aito/tasks/:id', async () => HttpResponse.json(await heldPatch)),
    );

    // Wrapped in a Router: unlike the Done-state test above, this one enters
    // edit mode (to read the Scan Cost input on reopen), which mounts
    // ImpressionFields — it renders a react-router `Link` and throws without
    // a router in the tree.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
    const Host = ({ open }: { open: boolean }) => (
      <QueryClientProvider client={client}>
        <BrowserRouter>
          <ToastProvider>{open ? <ProjectDetailPanel project={project} onClose={vi.fn()} onDelete={vi.fn()} /> : null}</ToastProvider>
        </BrowserRouter>
      </QueryClientProvider>
    );

    const { rerender } = rtlRender(<Host open />);
    await editAllTasks();
    const scanInput = await screen.findByLabelText('Scan Cost');
    fireEvent.change(scanInput, { target: { value: '700' } });

    // Close before the PATCH resolves.
    rerender(<Host open={false} />);

    // Now let the PATCH land, well after the panel (and its tasks query
    // observer) is gone — this is the settle-after-close ordering.
    stored = { ...stored, scan_cost: 700 };
    await act(async () => {
      releasePatch(stored);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Reopen well inside the 60s staleTime window.
    rerender(<Host open />);
    await editAllTasks();

    expect(await screen.findByLabelText('Scan Cost')).toHaveValue(700);
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
  it('right-aligns the project total', async () => {
    // mockTask's only priced step (scan, 500) is not done, so the header
    // total is the full 500 — waiting for it also waits out the tasks fetch.
    // Located via the caption's own testid rather than a font-size class:
    // this test used to key on `text-2xl` and broke the moment the size was
    // tuned to the design reference, which told us nothing about alignment.
    show();
    const caption = await screen.findByTestId('panel-header-caption');
    const moneyBlock = caption.parentElement!;
    // The caption mounts at 0/0 before the tasks fetch resolves, so wait for
    // the real total rather than asserting on the empty first paint.
    await waitFor(() => expect(moneyBlock.textContent).toContain('$500.00'));
    expect(moneyBlock.className).toContain('text-right');
  });

  it('shows nothing about a quote on a manually created project', () => {
    show();
    expect(document.querySelector('a[href*="books.zoho"]')).toBeNull();
  });

  it('links an imported project to its quote in Zoho Books, from both the header eyebrow and the quote row', () => {
    // Two links now share the accessible name: the header's compact eyebrow
    // (Project #12 · DEV26-2462) and the quote row's full entry with the
    // print button. Both must point at the same quote.
    show({
      quote_id: 'e2',
      quote_number: 'DEV26-2462',
      quote_date: '2026-07-28',
      quote_total: 5600,
      quote_url: 'https://books.zoho.eu/app/999#/estimates/e2',
    });
    const links = screen.getAllByRole('link', { name: /DEV26-2462/ });
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link).toHaveAttribute('href', 'https://books.zoho.eu/app/999#/estimates/e2');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    }
  });

  it('shows the print button for a project with a quote', () => {
    // Replaces the quote's own date and total, which are no longer shown here.
    show({ quote_id: 'e2', quote_number: 'DEV26-2462' });
    expect(screen.getByRole('button', { name: /print quote/i })).toBeInTheDocument();
  });

  it('labels the description field', async () => {
    show();
    expect(await screen.findByText('Product description')).toBeInTheDocument();
  });

  it('shows the seller and the creator', async () => {
    show({ quote_number: 'DEV26-2462', quote_salesperson: 'Marie VENDEUSE', created_by: 'paul' });
    expect(await screen.findByText('Marie VENDEUSE')).toBeInTheDocument();
    expect(screen.getByTestId('record-created')).toHaveTextContent('· paul');
  });

  it('omits the seller row entirely when the project has no seller', async () => {
    // An empty "Seller" is noise, not information — the same rule the phone
    // and email rows follow. Created is different: it names the creator
    // "unknown" rather than trailing off, because "nobody is recorded" is
    // itself worth stating for a card that predates the column or was made
    // with auth off.
    show({ quote_number: 'DEV26-2462', quote_salesperson: null, created_by: null });
    await waitFor(() => expect(screen.getByTestId('record-created')).toBeInTheDocument());
    expect(screen.queryByText('Seller')).not.toBeInTheDocument();
    expect(screen.getByTestId('record-created')).toHaveTextContent('· unknown');
  });
});

describe('ProjectDetailPanel left column cards', () => {
  it('groups the left column into four cards, description first, for an imported project', () => {
    // quote_number set (imported from Zoho) is what earns the Quote card —
    // see the sibling test below for the hand-made project, which has none.
    show({ quote_number: 'DEV26-2462' });
    const headings = screen.getAllByTestId('panel-card-heading').map((n) => n.textContent);
    expect(headings).toEqual(['Product description', 'Stage & work left', 'Quote', 'Record']);
  });

  it('omits the Quote card entirely for a hand-made project, rather than showing it empty', () => {
    // The default fixture has quote_number: null. A "Quote" heading over an
    // empty body would be exactly the noise the omitted Email/Seller rows
    // elsewhere in this panel are built to avoid.
    show();
    const headings = screen.getAllByTestId('panel-card-heading').map((n) => n.textContent);
    expect(headings).toEqual(['Product description', 'Stage & work left', 'Record']);
  });

  it('folds the creator into the created timestamp', async () => {
    show({ created_by: 'admin' });
    await waitFor(() => expect(screen.getByTestId('record-created')).toBeInTheDocument());
    expect(screen.getByTestId('record-created')).toHaveTextContent('· admin');
    expect(screen.queryByText(/^created by/i)).not.toBeInTheDocument();
  });

  it('says the creator is unknown rather than trailing off', async () => {
    show({ created_by: null });
    await waitFor(() => expect(screen.getByTestId('record-created')).toHaveTextContent(/· unknown/));
  });

  it('takes both halves of last activity from the newest event', async () => {
    // occurred_at and the actor belong together; updated_at paired with the
    // newest actor's name would describe two different moments. mockEvent's
    // occurred_at (2026-07-29) deliberately differs from the fixture's own
    // updated_at (2026-07-27) — asserting the actor alone would still pass if
    // the timestamp half were wrongly paired with updated_at instead, which
    // is exactly the regression this test (and the code's own comment) exist
    // to catch.
    server.use(
      http.get('/api/v1/aito/12/events', () => HttpResponse.json({ events: [mockEvent], has_more: false })),
    );
    show();
    // Visible text carries the DATE only — the time made "{when} · {who}"
    // wrap the author onto its own line — and the full timestamp moved to the
    // row's tooltip. occurred_at (07-29) still differs from the fixture's
    // updated_at (07-27) by date alone, so the wrong-pairing regression this
    // test exists for is still caught by the visible half.
    const occurred = parseUTCDate(mockEvent.occurred_at)!;
    const expectedWhen = occurred.toLocaleDateString(i18n.language, { dateStyle: 'short' });
    const expectedFull = occurred.toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' });
    await waitFor(() => expect(screen.getByTestId('record-activity')).toHaveTextContent('· admin'));
    expect(screen.getByTestId('record-activity')).toHaveTextContent(expectedWhen);
    expect(screen.getByTestId('record-activity')).toHaveAttribute('title', expectedFull);
  });

  it('falls back to updated_at with no actor when the project has no events', async () => {
    // A card created before the history feature landed.
    server.use(http.get('/api/v1/aito/12/events', () => HttpResponse.json({ events: [], has_more: false })));
    show();
    await waitFor(() => expect(screen.getByTestId('record-activity')).toBeInTheDocument());
    expect(screen.getByTestId('record-activity')).not.toHaveTextContent('·');
  });

  // ACTOR_FALLBACK_KEY (ProjectDetailPanel.tsx) picks a translated stand-in
  // by actor_class when the event carries no actor_name — user-visible copy
  // shipped in 13 locales, previously untested because mockEvent always
  // carries actor_name: 'admin'.
  it.each([
    ['user', 'unknown user'],
    ['client', 'the client'],
    ['system', 'automatic'],
  ] as const)('falls back to "%s" -> "%s" when a %s event has no actor_name', async (actorClass, expected) => {
    server.use(
      http.get('/api/v1/aito/12/events', () =>
        HttpResponse.json({
          events: [{ ...mockEvent, actor_class: actorClass, actor_name: null }],
          has_more: false,
        }),
      ),
    );
    show();
    await waitFor(() => expect(screen.getByTestId('record-activity')).toHaveTextContent(`· ${expected}`));
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

  it('shows that same note on an idle declined card, which is the normal case', async () => {
    // It used to live inside the sync row, which renders only for
    // pending/error/locked — so the one card that most needs the explanation
    // (restored from the trash, or imported from an already-declined quote,
    // both of which settle at 'idle') never got it.
    show({ quote_sync_state: 'idle', quote_status: 'declined' });
    expect(
      await screen.findByText('Zoho does not allow reverting a quote back to draft.'),
    ).toBeInTheDocument();
  });

  it('surfaces a recorded conflict even though the project is idle', async () => {
    // The whole point of the block being its own stored fact: an 'idle'
    // project renders no sync row at all, so a conflict folded into
    // quote_sync_error would reach nobody.
    show({
      quote_sync_state: 'idle',
      quote_status: 'accepted',
      quote_status_block: 'conflict',
      quote_status_remote: 'declined',
    });
    expect(
      await screen.findByText('The board says Accepted but Books says Declined — resolve it in Books'),
    ).toBeInTheDocument();
  });

  it('surfaces a rejected push, with both statuses localised', async () => {
    show({
      quote_sync_state: 'idle',
      quote_status: 'accepted',
      quote_status_block: 'rejected',
      quote_status_remote: 'draft',
    });
    expect(
      await screen.findByText('Books refused to change this quote to Accepted while it reads Draft'),
    ).toBeInTheDocument();
  });

  it('renders no block row when nothing is blocked', async () => {
    show({ quote_sync_state: 'idle' });
    expect(await screen.findByText('ACME SARL')).toBeInTheDocument();
    expect(screen.queryByText(/resolve it in Books/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Books refused/)).not.toBeInTheDocument();
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
      scanDescription: 'SD',
      modelisationDescription: 'MD',
      impressionDescription: 'ID',
      usinageDescription: 'UD',
      scanCost: 1,
      modelisationCost: 2,
      usinageCost: 3,
      impressionCost: 4,
      impressionDiscountPct: 6,
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

describe('ProjectDetailPanel activity rail', () => {
  it('shows the activity rail alongside the tasks', async () => {
    vi.spyOn(api, 'getAitoEvents').mockResolvedValue({ events: [], has_more: false });
    render(<ProjectDetailPanel project={project} onClose={vi.fn()} onDelete={vi.fn()} />);
    expect(await screen.findByRole('region', { name: /activity/i })).toBeInTheDocument();
  });

  it('refetches the timeline after the description is edited', async () => {
    const events = vi.spyOn(api, 'getAitoEvents').mockResolvedValue({ events: [], has_more: false });
    vi.spyOn(api, 'updateAitoProject').mockResolvedValue({ ...project, description: 'Changed' });
    const user = userEvent.setup();
    render(<ProjectDetailPanel project={project} onClose={vi.fn()} onDelete={vi.fn()} />);

    await screen.findByRole('region', { name: /activity/i });
    const before = events.mock.calls.length;

    await user.click(screen.getByRole('button', { name: /edit description/i }));
    // getByRole('textbox') is now ambiguous: ActivityRail's note <input> is a
    // second textbox alongside the description <textarea>. Filter to the
    // <textarea> specifically rather than relying on DOM order.
    const box = screen.getAllByRole('textbox').find((el) => el.tagName === 'TEXTAREA')!;
    await user.clear(box);
    await user.type(box, 'Changed');
    await user.tab();

    await waitFor(() => expect(events.mock.calls.length).toBeGreaterThan(before));
  });
});

describe('ProjectDetailPanel footer', () => {
  it('has no close button — outside-click and Escape are the ways out', () => {
    show();
    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
  });

  it('focuses the dialog itself on open, so Escape and Tab start inside it', () => {
    show();
    expect(screen.getByRole('dialog')).toHaveFocus();
  });

  it('still closes on Escape', async () => {
    const onClose = vi.fn();
    render(<ProjectDetailPanel project={project} onClose={onClose} onDelete={vi.fn()} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('leaves the footer to the destructive action alone', () => {
    show({ quote_id: 'e2', quote_number: 'DEV26-2462' });
    const footer = screen.getByTestId('panel-footer');
    expect(within(footer).getByRole('button', { name: /move to trash|delete project/i })).toBeInTheDocument();
    // Print and Open in Zoho act on the quote, so they live in the Quote card
    // beside its number and status — not in a bar spanning the whole panel.
    expect(within(footer).queryByRole('button', { name: /print/i })).not.toBeInTheDocument();
    expect(within(footer).queryByRole('link', { name: /zoho/i })).not.toBeInTheDocument();
  });

  it('puts Print quote in the Quote card, with no duplicate Zoho control', async () => {
    show({ quote_id: 'e2', quote_number: 'DEV26-2462', quote_url: 'https://books.zoho.com/e2' });
    const quoteCard = (await screen.findAllByTestId('panel-card-heading'))
      .find((n) => /quote/i.test(n.textContent ?? ''))!.parentElement!;

    expect(within(quoteCard).getByRole('button', { name: /print quote/i })).toBeInTheDocument();
    // The quote NUMBER is already a link to Zoho; a separate "Open in Zoho"
    // button was a second affordance for one destination in a six-row card.
    // The number keeps its link, so the destination is not lost.
    expect(within(quoteCard).getByRole('link', { name: /DEV26-2462/ })).toHaveAttribute(
      'href',
      'https://books.zoho.com/e2',
    );
    expect(within(quoteCard).queryByRole('link', { name: /open in zoho/i })).not.toBeInTheDocument();
  });

  it('omits the trash control for a project already in the trash', () => {
    render(<ProjectDetailPanel project={project} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /move to trash|delete project/i })).not.toBeInTheDocument();
  });
});

describe('ProjectDetailPanel mark as done', () => {
  const doneButton = () =>
    within(screen.getByTestId('panel-footer')).queryByRole('button', { name: /mark project as done/i });

  it('offers it in the footer for a released card in Finish', () => {
    show({ column: 'finish', move_lock: null, quote_status: 'accepted' });
    expect(doneButton()).toBeEnabled();
  });

  it('does not offer it in any other column', () => {
    for (const column of ['devis', 'waiting', 'scan', 'model', 'print', 'done'] as const) {
      const { unmount } = show({ column, move_lock: null, quote_status: 'accepted' });
      expect(doneButton()).not.toBeInTheDocument();
      unmount();
    }
  });

  it('does not offer it while the rules still hold the card', () => {
    // move_lock is the server's own derived value, and the move endpoint would
    // 409 the attempt — same gate the board card uses.
    show({ column: 'finish', move_lock: 'steps', quote_status: 'accepted' });
    expect(doneButton()).not.toBeInTheDocument();
  });

  it('never shares the bar with the quote actions', () => {
    // A card only reaches Finish on an accepted quote, and QuoteStatusActions
    // renders nothing once accepted. Asserted rather than assumed: the two
    // blocks are styled alike, so a regression that put both on the bar would
    // read as one wide row of near-identical pills.
    show({ column: 'finish', move_lock: null, quote_status: 'accepted' });
    const footer = screen.getByTestId('panel-footer');
    expect(within(footer).queryByRole('button', { name: /mark as sent|accept quote|decline quote/i }))
      .not.toBeInTheDocument();
  });

  it('fires the move only once the 500ms hold completes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Held open by hand: MSW has no handler for this endpoint, and the unmocked
    // call bypasses to the real network, which refuses fast enough to settle the
    // mutation before the pending assertion below runs.
    const move = vi.spyOn(api, 'moveAitoProject').mockImplementation(() => new Promise(() => {}));
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      show({ column: 'finish', move_lock: null, quote_status: 'accepted' });
      const button = doneButton()!;

      await user.pointer({ keys: '[MouseLeft>]', target: button });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(button).toBeEnabled();

      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(button).toBeDisabled();

      // React Query's `onMutate` awaits `cancelQueries` before it ever reaches
      // `mutationFn`, so the request is a microtask behind the `isPending` flip
      // asserted above — flush before asking what was actually sent.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // The destination, spelled out: swapping it for 'finish' would turn this
      // into a silent no-op with every other assertion here still green.
      expect(move).toHaveBeenCalledWith(12, { column: 'done', position: 0 });
    } finally {
      vi.useRealTimers();
      move.mockRestore();
    }
  });
});

describe('ProjectDetailPanel delete', () => {
  it('offers delete in the expanded card, on a 1s hold', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const onDelete = vi.fn();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<ProjectDetailPanel project={project} onClose={vi.fn()} onDelete={onDelete} />);

      const footer = screen.getByTestId('panel-footer');
      const button = within(footer).getByRole('button', { name: /move to trash|delete project/i });
      await user.pointer({ keys: '[MouseLeft>]', target: button });
      vi.advanceTimersByTime(600);
      expect(onDelete).not.toHaveBeenCalled(); // 500ms is not enough — this is the 1s gesture

      vi.advanceTimersByTime(500);
      expect(onDelete).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('separates the left column from the tasks on wide screens', () => {
    const { container } = render(<ProjectDetailPanel project={project} onClose={vi.fn()} onDelete={vi.fn()} />);
    // Task 10: the hairline `lg:border-l` dividers are gone — the panel body
    // became canvas (`bg-bambu-dark`) and every column now carries its own
    // padding, so a column's card content reads as a distinct block against
    // the canvas instead of needing a drawn line between columns.
    //
    // COUNTED, not merely found — same reasoning as the border version this
    // replaced: asserting padding on only one column would pass identically
    // if a second column were left flush against the canvas with none of its
    // own, which is exactly the kind of one-column regression this guard
    // exists to catch.
    expect(container.querySelectorAll('.lg\\:border-l')).toHaveLength(0);
    const grid = document.querySelector('[class*="lg:grid-cols-"]')!;
    const columns = Array.from(grid.children) as HTMLElement[];
    expect(columns).toHaveLength(3);
    for (const column of columns) {
      expect(column.className).toContain('px-5');
      expect(column.className).toContain('py-4');
    }
  });
});

describe('ProjectDetailPanel column badge', () => {
  it('marks a done project current on the rail', () => {
    // COLUMNS lost its `done` entry when Done came off the board; the rail
    // must read ALL_COLUMNS (via StageRail), or every finished card would
    // fail to find itself among the stages and render nothing as current.
    show({ column: 'done', move_lock: null });
    expect(screen.getByTestId('stage-node-done')).toHaveAttribute('data-state', 'current');
  });
});

describe('ProjectDetailPanel scroll architecture', () => {
  /** These are class assertions, and they prove less than a layout test would:
   *  jsdom computes no layout at all, so nothing here can show the panel
   *  actually stops growing or that any column actually scrolls. That is not
   *  a hypothetical gap — it is exactly how this bug shipped once already.
   *  The previous version of this suite asserted `lg:h-full` on the grid row,
   *  every asserted class was present and correctly spelled, and the test
   *  suite was green while the feature was completely broken in a real
   *  browser: `h-full` is a percentage height, a percentage height needs a
   *  *definite* parent height to resolve against, and a flex item's height
   *  (the panel body, `flex-1 min-h-0`) is not definite, so it silently fell
   *  back to `auto` and never capped anything. jsdom cannot catch that class
   *  of failure because it does not lay anything out — only a real browser
   *  (or Playwright) checking actual `scrollHeight`/`clientHeight` can. What
   *  these tests DO catch is the cruder regression — dropping a `min-h-0`,
   *  losing `lg:flex-1` off the row, or adding a fourth column without a
   *  scroller — which changes no rendered text, fails no type check, and is
   *  invisible until someone opens a project with a long history on a wide
   *  screen. Treat a pass here as "the structure is intact", never as "the
   *  scrolling works". */

  it('caps the panel at the viewport and lets the body flex inside it', () => {
    show();
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('max-h-[calc(100vh-2rem)]');
    expect(dialog.className).toContain('flex-col');
  });

  it('turns the body into a non-scrolling flex column on wide screens, so the grid can flex inside it', () => {
    show();
    const grid = document.querySelector('[class*="lg:grid-cols-"]')!;
    const body = grid.parentElement!;
    expect(body.className).toContain('lg:flex');
    expect(body.className).toContain('lg:flex-col');
    expect(body.className).toContain('lg:overflow-hidden');
  });

  it('gives every grid column its own scroller on wide screens', () => {
    show();
    const grid = document.querySelector('[class*="lg:grid-cols-"]');
    expect(grid).not.toBeNull();

    // lg:flex-1 gives the row a definite height from the flex algorithm
    // (a percentage like lg:h-full cannot get one from a flex-item parent).
    // lg:min-h-0 is still required alongside it: without it the row refuses
    // to shrink below its content and the flex-1 height above does nothing.
    expect(grid!.className).toContain('lg:flex-1');
    expect(grid!.className).toContain('lg:min-h-0');

    const columns = Array.from(grid!.children) as HTMLElement[];
    expect(columns).toHaveLength(3);
    for (const column of columns) {
      expect(column.className).toContain('lg:overflow-y-auto');
      expect(column.className).toContain('lg:min-h-0');
      expect(column.className).toContain('scrollbar-hide');
    }
  });

  it('keeps the body a shrinkable flex child', () => {
    show();
    const grid = document.querySelector('[class*="lg:grid-cols-"]')!;
    const body = grid.parentElement!;
    expect(body.className).toContain('flex-1');
    expect(body.className).toContain('min-h-0');
  });
});

describe('ProjectDetailPanel surfaces', () => {
  it('ranks elevation: only the task cards cast a shadow', async () => {
    show();
    expect(screen.getByTestId('panel-column-tasks')).toBeInTheDocument();
    // Reference cards carry a border and no shadow.
    const referenceCard = screen.getAllByTestId('panel-card-heading')[0].parentElement!;
    expect(referenceCard.className).toContain('border-bambu-dark-tertiary');
    expect(referenceCard.className).not.toContain('card-shadow');
    // Task cards are the front plane: they DO cast a shadow. Selected via a
    // class the fix doesn't touch (`border`, TaskRow's own container), not
    // `card-shadow` itself, so this half of the test can actually fail if the
    // class is dropped from TaskRow.
    const taskCard = (await screen.findByRole('heading', { name: /^Bracket mount/ })).closest('.border')!;
    expect(taskCard.className).toContain('card-shadow');
  });

  it('puts the body on the canvas tier, not the panel tier', () => {
    show();
    expect(screen.getByRole('dialog').className).toContain('bg-bambu-dark');
    expect(screen.getByRole('dialog').className).not.toContain('bg-bambu-dark-secondary');
  });

  // Three separate cases rather than one with cleanup() calls in the middle:
  // a test that unmounts and remounts twice inside a single `it` shares a
  // query client across the renders and is a poor neighbour under parallel
  // load. The glyph is aria-hidden, so the company/individual split is
  // asserted through the text that carries it for assistive tech.
  it('marks a company client as a company', () => {
    show({ client_is_company: true });
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/company name/i);
  });

  it('marks an individual client as an individual', () => {
    show({ client_is_company: false });
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/client name/i);
  });

  it('reads a legacy card with a null flag as an individual', () => {
    show({ client_is_company: null });
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/client name/i);
  });

  it('keeps the sync row inside the Quote card', async () => {
    show({ quote_number: 'DEV26-2476', quote_sync_state: 'pending' });
    const quoteCard = (await screen.findAllByTestId('panel-card-heading'))
      .find((n) => /quote/i.test(n.textContent ?? ''))!.parentElement!;
    expect(quoteCard.textContent).toMatch(/pending/i);
  });

  it('still shows a sync message when the project has no quote number', async () => {
    // The card is gated on quote_number; a message must not be gated with it,
    // or a conflict reaches nobody — exactly how a previous design lost these.
    show({ quote_number: null, quote_sync_state: 'error', quote_sync_error: 'Zoho unreachable' });
    expect(await screen.findByText(/zoho unreachable/i)).toBeInTheDocument();
  });

  it('raises the header off the body: lifted base plus a cast shadow', () => {
    show();
    // The reference band is a masthead sitting ABOVE the canvas, not a tinted
    // strip level with it. Both halves shipped missing, which is why the
    // header read as flat however the type was tuned. `--bg-tertiary` rather
    // than a white percentage, so the lift survives light mode.
    // Selected by the z-index that gives the band its stacking context, not
    // by `border-b` — the bottom border is gone, the cast shadow separates it
    // from the body now, and keying on a border made this fail for a reason
    // unrelated to what it asserts.
    const header = screen.getByRole('heading', { level: 2 }).closest('div.z-\\[2\\]') as HTMLElement;
    expect(header.style.backgroundImage).toContain('var(--bg-tertiary)');
    expect(header.style.boxShadow).toBe('0 12px 26px -14px rgba(0, 0, 0, 0.8)');
    // Needs its own stacking context or the body paints over the shadow.
    expect(header.className).toContain('z-[2]');
  });

  it('clips its corners, so the header gradient and footer fill cannot square them off', () => {
    show();
    // The header is full-bleed with a gradient and the footer with a solid
    // fill; both are square-cornered and full-width. Without this the panel
    // renders as a rectangle with four notched corners.
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('rounded-[.85rem]');
    expect(dialog.className).toContain('overflow-hidden');
  });
});

// Visual-parity fixes against the approved design reference (t-mix2, "7 ·
// Canvas, weighted") — seven divergences the side-by-side comparison found
// between the shipped panel and the mock. Each test below pins one.
describe('ProjectDetailPanel visual parity: header quote-status pill', () => {
  it('shows the quote status as an accented pill in the eyebrow', () => {
    show({ quote_number: 'DEV26-2462', quote_status: 'accepted' });
    const pill = screen.getByTestId('panel-quote-status-pill');
    expect(pill).toHaveTextContent('Accepted');
    // Accent-themed, not a literal colour — see the panel's theming rule.
    expect(pill.className).toContain('text-bambu-green');
    expect(pill.className).toContain('border-bambu-green/40');
    expect(pill.className).toContain('bg-bambu-green/10');
  });

  it('omits the pill entirely when the project has no quote status', () => {
    show({ quote_number: 'DEV26-2462', quote_status: null });
    expect(screen.queryByTestId('panel-quote-status-pill')).not.toBeInTheDocument();
  });
});

describe('ProjectDetailPanel visual parity: header contact icons', () => {
  it('gives the phone and email chips a leading icon, matching the reference', () => {
    show();
    const phoneButton = screen.getByRole('button', { name: /\+689-87123456/ });
    expect(phoneButton.querySelector('svg.lucide-phone')).not.toBeNull();
    const emailButton = screen.getByRole('button', { name: /hi@acme\.pf/ });
    expect(emailButton.querySelector('svg.lucide-mail')).not.toBeNull();
  });
});

describe('ProjectDetailPanel visual parity: tasks column header', () => {
  it('replaces TaskEditor\'s own header with a Work eyebrow and an aggregate progress bar', async () => {
    server.use(
      http.get('/api/v1/aito/12/tasks', () =>
        HttpResponse.json([
          { ...mockTask, scan_cost: 3500, scan_done: true, modelisation_cost: 7000, modelisation_done: false },
        ]),
      ),
    );
    show();
    const tasksColumn = screen.getByTestId('panel-column-tasks');
    await waitFor(() => expect(within(tasksColumn).getByTestId('panel-work-progress')).toBeInTheDocument());
    expect(within(tasksColumn).getByText('Work')).toBeInTheDocument();
    // Same tally the panel header's own caption reads — see the doc on
    // ProjectDetailPanel's stepsDone/stepsTotal for why this must be the
    // exact same variables, not a second computation.
    expect(screen.getByTestId('panel-work-steps-count')).toHaveTextContent('1/2 steps');
    // The money now lives only in the panel header — TaskEditor's own
    // "Project total" heading must not also render here.
    expect(within(tasksColumn).queryByText('Project total')).not.toBeInTheDocument();
  });
});

describe('ProjectDetailPanel visual parity: quote card rows', () => {
  const quoteCard = () =>
    screen.getAllByTestId('panel-card-heading').find((h) => h.textContent === 'Quote')!.parentElement!;

  it('shows a Number row and, when the project has a status, a Status row', () => {
    show({ quote_number: 'DEV26-2462', quote_status: 'accepted' });
    const card = quoteCard();
    expect(within(card).getByText('Number')).toBeInTheDocument();
    expect(within(card).getByText('DEV26-2462')).toBeInTheDocument();
    expect(within(card).getByText('Status')).toBeInTheDocument();
    expect(within(card).getByText('Accepted')).toBeInTheDocument();
  });

  it('omits the Status row when the project has no quote status', () => {
    show({ quote_number: 'DEV26-2462', quote_status: null });
    const card = quoteCard();
    expect(within(card).queryByText('Status')).not.toBeInTheDocument();
  });
});

// The header pill and the Quote card's Status row both render the same
// project.quote_status, a few hundred pixels apart in the same column. They
// used to hardcode bambu-green independently of the actual status, so a
// declined or expired quote still read as the green "success" accent — the
// opposite of QuoteStatusActions.tsx, which paints a decline in status-error
// a few inches below. These pin both surfaces to the shared quoteStatusTone
// map so they cannot drift apart again.
describe('ProjectDetailPanel visual parity: quote status tone matches its actual status', () => {
  const quoteCard = () =>
    screen.getAllByTestId('panel-card-heading').find((h) => h.textContent === 'Quote')!.parentElement!;

  it('accepted renders the success accent (bambu-green) in both the pill and the Status row', () => {
    show({ quote_number: 'DEV26-2462', quote_status: 'accepted' });
    const pill = screen.getByTestId('panel-quote-status-pill');
    expect(pill.className).toContain('text-bambu-green');
    expect(within(quoteCard()).getByText('Accepted').className).toContain('text-bambu-green');
  });

  it('declined renders the error accent (status-error), matching QuoteStatusActions\' decline button', () => {
    show({ quote_number: 'DEV26-2462', quote_status: 'declined' });
    const pill = screen.getByTestId('panel-quote-status-pill');
    expect(pill.className).toContain('text-status-error');
    expect(pill.className).not.toContain('bambu-green');
    const statusValue = within(quoteCard()).getByText('Declined');
    expect(statusValue.className).toContain('text-status-error');
    expect(statusValue.className).not.toContain('bambu-green');
  });

  it('expired renders the warning accent (status-warning), not the success green', () => {
    show({ quote_number: 'DEV26-2462', quote_status: 'expired' });
    const pill = screen.getByTestId('panel-quote-status-pill');
    expect(pill.className).toContain('text-status-warning');
    expect(pill.className).not.toContain('bambu-green');
    const statusValue = within(quoteCard()).getByText('Expired');
    expect(statusValue.className).toContain('text-status-warning');
    expect(statusValue.className).not.toContain('bambu-green');
  });

  it('an unmapped status falls back to neutral, never green — Zoho can add statuses this panel has never seen', () => {
    show({ quote_number: 'DEV26-2462', quote_status: 'on_hold' });
    const pill = screen.getByTestId('panel-quote-status-pill');
    expect(pill.className).toContain('text-bambu-gray-light');
    expect(pill.className).not.toContain('bambu-green');
    const statusValue = within(quoteCard()).getByText('on_hold');
    expect(statusValue.className).toContain('text-bambu-gray-light');
    expect(statusValue.className).not.toContain('bambu-green');
  });
});

describe('ProjectDetailPanel visual parity: footer buttons', () => {
  it('shows a visible "Print quote" label next to the icon, not just an aria-label', async () => {
    show({ quote_id: 'e2', quote_number: 'DEV26-2462' });
    const quoteCard = (await screen.findAllByTestId('panel-card-heading'))
      .find((n) => /quote/i.test(n.textContent ?? ''))!.parentElement!;
    const button = within(quoteCard).getByRole('button', { name: /print quote/i });
    expect(button).toHaveTextContent('Print quote');
  });

  it('renders the trash control as a permanent bordered button, not hover-revealed', () => {
    show();
    const footer = screen.getByTestId('panel-footer');
    const button = within(footer).getByRole('button', { name: /move to trash/i });
    expect(button.className).not.toContain('opacity-0');
    expect(button.className).toContain('border');
    expect(button).toHaveTextContent('Move to trash');
  });
});

describe('ProjectDetailPanel visual parity: corner radii', () => {
  it('rounds the dialog to .85rem and the reference cards to .6rem', () => {
    show();
    expect(screen.getByRole('dialog').className).toContain('rounded-[.85rem]');
    const referenceCard = screen.getAllByTestId('panel-card-heading')[0].parentElement!;
    expect(referenceCard.className).toContain('rounded-[.6rem]');
  });

  it('rounds task cards to .6rem too', async () => {
    show();
    const taskCard = (await screen.findByRole('heading', { name: /^Bracket mount/ })).closest('.border')!;
    expect(taskCard.className).toContain('rounded-[.6rem]');
  });
});
