import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { ProjectDetailPanel } from '../../components/aito/ProjectDetailPanel';
import type { AitoProject, AitoTask } from '../../api/client';

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
  task_count: 0,
  tasks_total: 0,
  task_services: [],
  created_at: '2026-07-27T00:00:00',
  updated_at: '2026-07-27T00:00:00',
};

const show = (overrides: Partial<AitoProject> = {}) =>
  render(<ProjectDetailPanel project={{ ...project, ...overrides }} onClose={vi.fn()} />);

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

    expect(await screen.findByDisplayValue('Bracket mount')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Print in PA6-CF')).toBeInTheDocument();
    expect(screen.getByLabelText('Scan3D')).toHaveValue(500);
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
    const scanInput = await screen.findByLabelText('Scan3D');
    fireEvent.change(scanInput, { target: { value: '700' } });

    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedId).toBe('101');
    expect(capturedBody).toEqual({ scan_cost: 700 });
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
    const scanInput = await screen.findByLabelText('Scan3D');

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
    const scanInput = await screen.findByLabelText('Scan3D');
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
    const scanInputs = await screen.findAllByLabelText('Scan3D');
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
    await screen.findByDisplayValue('Bracket mount');

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
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(deletedId).toBe('101');
    vi.useRealTimers();
  });

  it('a failed PATCH shows the aito.saveFailed toast and keeps the panel\'s other state', async () => {
    server.use(
      http.patch('/api/v1/aito/tasks/:id', () => HttpResponse.json({ error: 'boom' }, { status: 500 })),
    );

    show();
    const scanInput = await screen.findByLabelText('Scan3D');
    fireEvent.change(scanInput, { target: { value: '700' } });

    expect(await screen.findByText(/could not save your changes/i)).toBeInTheDocument();

    // The edited value stays on screen (not rolled back), and the rest of the
    // panel — the client details rendered outside TaskEditor — is untouched.
    expect(screen.getByLabelText('Scan3D')).toHaveValue(700);
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

    // Give every query (filaments, printers, defaults, settings, tasks)
    // every chance to resolve and the recompute effect every chance to fire.
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

    await screen.findByRole('combobox', { name: /material/i });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(patched).toBe(false);
  });

  it('editing one row then deleting it does not leak its edited state onto the row that slides into its slot', async () => {
    // The residual this file exists to close: TaskEditor used to key rows by
    // array index. Editing row A's print inputs sets `hasEdited` on the
    // ImpressionFields instance mounted at index 0; hold-deleting row A then
    // slides row B up into index 0, and with an index key React reuses that
    // same mounted instance — `hasEdited: true` included — for row B's data.
    // B's untouched, frozen `impression_cost` then gets recomputed and
    // PATCHed over the stored figure despite nobody ever having touched B.
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

    // Row A (task 101, index 0): edit a print input, setting `hasEdited` on
    // the ImpressionFields instance mounted at index 0.
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
      await vi.advanceTimersByTimeAsync(2000);
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
});
