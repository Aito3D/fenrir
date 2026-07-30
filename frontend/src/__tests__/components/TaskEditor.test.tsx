/**
 * Tests for TaskRow and TaskEditor — the presentational task-list UI for an
 * Aito project. Both components are fully controlled (no internal state, no
 * persistence), so most tests either drive a stateful harness that mirrors
 * what a real caller (create modal / detail panel) would do, or assert
 * directly on the arguments passed to `onChange`.
 */

import { useState } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { TaskRow } from '../../components/aito/TaskRow';
import { TaskEditor } from '../../components/aito/TaskEditor';
import { emptyTaskDraft, taskTotal } from '../../utils/taskDraft';
import type { TaskDraft } from '../../utils/taskDraft';
import { formatMoney } from '../../utils/pricing';

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

beforeEach(() => {
  // TaskRow always renders ImpressionFields (Impression3D is one of the four
  // services on every task), so every test needs these three queries mocked,
  // per the brief. Non-empty lists so ImpressionFields renders its real
  // fields instead of the "not configured" fallback message.
  server.use(
    http.get('/api/v1/calculator/filaments/', () => HttpResponse.json(mockFilaments)),
    http.get('/api/v1/calculator/printers/', () => HttpResponse.json(mockPrinters)),
    http.get('/api/v1/calculator/defaults', () => HttpResponse.json(mockDefaults)),
  );
});

/** Mirrors how a real caller would wire TaskRow: state lives outside the
 *  component, `onChange` replaces it wholesale. */
function ControlledTaskRow({
  initial,
  onChangeSpy,
}: {
  initial: TaskDraft;
  onChangeSpy: (next: TaskDraft) => void;
}) {
  const [task, setTask] = useState(initial);
  // Open and editing, because these tests are about the fields inside a row
  // (title, description, the four cost inputs, ImpressionFields), which only
  // render in edit mode — not about the disclosure or the read/edit split
  // themselves. Both are covered by their own tests below.
  const [expanded, setExpanded] = useState(true);
  const [editing, setEditing] = useState(true);
  return (
    <TaskRow
      task={task}
      index={0}
      onChange={(next) => {
        onChangeSpy(next);
        setTask(next);
      }}
      onRemove={vi.fn()}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      editing={editing}
      onToggleEdit={() => setEditing((v) => !v)}
      canTick
    />
  );
}

/** Same wiring, one level up: state lives outside `TaskEditor`, `onChange`
 *  replaces the whole array. Needed (rather than the single-task
 *  `ControlledTaskRow`) whenever a test must actually see a selection stick
 *  in ImpressionFields — an uncontrolled harness would let the UI flash the
 *  new value and immediately snap back to the old prop. */
function ControlledTaskEditor({
  initial,
  onChangeSpy,
}: {
  initial: TaskDraft[];
  onChangeSpy: (next: TaskDraft[]) => void;
}) {
  const [tasks, setTasks] = useState(initial);
  return (
    <TaskEditor
      value={tasks}
      onChange={(next) => {
        onChangeSpy(next);
        setTasks(next);
      }}
      onRemove={vi.fn()}
      canTick
    />
  );
}

/** Rows render collapsed, so any test that drives the fields inside one has to
 *  open it first. The row heading is the toggle; its accessible name starts
 *  with the task's title, or "Task N" while the title is still blank, and also
 *  carries the badges and total shown while collapsed — hence a regex rather
 *  than an exact string. */
async function expandTask(name: RegExp = /^Task 1/i) {
  fireEvent.click(await screen.findByRole('button', { name, expanded: false }));
}

/** Switches an already-expanded row into edit mode, revealing the raw
 *  title/description/cost/ImpressionFields form in place of the read-only
 *  step list. The Edit button is always rendered (it lives in the row header,
 *  not the collapsible body), so this only disambiguates by index when more
 *  than one row is on screen. */
async function editTask(index = 0) {
  const buttons = await screen.findAllByRole('button', { name: /edit task/i });
  fireEvent.click(buttons[index]);
}

describe('TaskEditor', () => {
  it('"Add task" appends a draft with all four services empty', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<TaskEditor value={[]} onChange={onChange} onRemove={vi.fn()} canTick />);

    await user.click(screen.getByRole('button', { name: /add task/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as TaskDraft[];
    expect(next).toHaveLength(1);
    // `uid` is a fresh client-side identity per draft (see taskDraft.ts), so
    // it deliberately differs from a second, independent `emptyTaskDraft()`
    // call — compare it structurally instead, then check every other field.
    expect(next[0].uid).toEqual(expect.any(String));
    expect(next[0]).toEqual({ ...emptyTaskDraft(), uid: next[0].uid });
  });

  it('never mutates the input array — onChange receives a new array', async () => {
    const value: TaskDraft[] = [emptyTaskDraft()];
    const onChange = vi.fn();
    render(<TaskEditor value={value} onChange={onChange} onRemove={vi.fn()} canTick />);
    await expandTask();
    await editTask();

    fireEvent.change(screen.getByLabelText('Scan Cost'), { target: { value: '7' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    const result = onChange.mock.calls[0][0] as TaskDraft[];
    expect(result).not.toBe(value);
    // The original array and its entries are untouched.
    expect(value[0].scanCost).toBeNull();
    expect(result[0].scanCost).toBe(7);
  });

  it('renders rows collapsed, showing only the name, services and total', async () => {
    const task: TaskDraft = { ...emptyTaskDraft(), title: 'Boîtier', scanCost: 4000, usinageCost: 500 };
    render(<TaskEditor value={[task]} onChange={vi.fn()} onRemove={vi.fn()} canTick />);

    // Visible while collapsed: the name, a badge per enabled service, the
    // total, and the remove control.
    const heading = await screen.findByRole('button', { name: /^Boîtier/, expanded: false });
    expect(screen.getByText('Scan')).toBeInTheDocument();
    expect(screen.getByText('Machining')).toBeInTheDocument();
    // Scoped to the heading: the project total above shows the same figure
    // while this is the only task, so a page-wide text match is ambiguous.
    expect(heading).toHaveTextContent(/4\D?500/);
    expect(screen.getByLabelText('Remove task')).toBeInTheDocument();

    // A service left disabled gets no badge — and nothing from the body is
    // reachable, which is the whole point of collapsing.
    expect(screen.queryByText('Modeling')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Scan Cost')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Optional title')).not.toBeInTheDocument();
  });

  it('a free service still gets a badge on a collapsed row', async () => {
    // null disables a service, 0 prices it at nothing. A badge row built on
    // truthiness instead of a null check would silently drop this one.
    const task: TaskDraft = { ...emptyTaskDraft(), title: 'Gratuit', scanCost: 0 };
    render(<TaskEditor value={[task]} onChange={vi.fn()} onRemove={vi.fn()} canTick />);

    expect(await screen.findByText('Scan')).toBeInTheDocument();
  });

  it('clicking a row heading expands it, and clicking again collapses it', async () => {
    const user = userEvent.setup();
    render(<TaskEditor value={[emptyTaskDraft()]} onChange={vi.fn()} onRemove={vi.fn()} canTick />);

    await user.click(await screen.findByRole('button', { name: /^Task 1/, expanded: false }));
    await user.click(screen.getByRole('button', { name: /edit task/i }));
    expect(screen.getByLabelText('Optional title')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Task 1/, expanded: true }));
    expect(screen.queryByLabelText('Optional title')).not.toBeInTheDocument();
  });

  it('expanding one row leaves its neighbours collapsed', async () => {
    // Guards the agreement between a row's React key and its expansion key:
    // if those ever diverge, toggling one row opens a different one.
    const user = userEvent.setup();
    const tasks = [
      { ...emptyTaskDraft(), title: 'Un' },
      { ...emptyTaskDraft(), title: 'Deux' },
    ];
    render(<TaskEditor value={tasks} onChange={vi.fn()} onRemove={vi.fn()} canTick />);

    await user.click(await screen.findByRole('button', { name: /^Deux/, expanded: false }));

    expect(screen.getByRole('button', { name: /^Un/, expanded: false })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Deux/, expanded: true })).toBeInTheDocument();

    // The Edit button lives in every row's header, not its collapsible body,
    // so both rows have one — index 1 is Deux, the expanded one.
    await editTask(1);

    // Exactly one body is mounted.
    expect(screen.getAllByLabelText('Optional title')).toHaveLength(1);
  });

  it('a task added with "+ Add task" opens expanded', async () => {
    const user = userEvent.setup();
    render(<ControlledTaskEditor initial={[]} onChangeSpy={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /add task/i }));

    expect(await screen.findByRole('button', { name: /^Task 1/, expanded: true })).toBeInTheDocument();
    expect(screen.getByLabelText('Optional title')).toBeInTheDocument();
  });

  it('adding a second task leaves the first one as the user left it', async () => {
    const user = userEvent.setup();
    render(<ControlledTaskEditor initial={[emptyTaskDraft()]} onChangeSpy={vi.fn()} />);

    // The pre-existing row starts collapsed and must stay that way; only the
    // new one opens.
    await user.click(screen.getByRole('button', { name: /add task/i }));

    expect(await screen.findByRole('button', { name: /^Task 2/, expanded: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Task 1/, expanded: false })).toBeInTheDocument();
  });

  it('holding the remove button for 1s calls onRemove with that index', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onRemove = vi.fn();
    render(
      <TaskEditor value={[emptyTaskDraft(), emptyTaskDraft()]} onChange={vi.fn()} onRemove={onRemove} canTick />,
    );
    const removeButtons = screen.getAllByLabelText('Remove task');

    await act(async () => {
      fireEvent.pointerDown(removeButtons[1]);
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(onRemove).toHaveBeenCalledWith(1);
    vi.useRealTimers();
  });

  it('does not fire before the full second has elapsed', async () => {
    // Bounds the hold from below. The test above advances exactly 1000ms, so
    // it already fails if the duration grows; without this one, shrinking it
    // to a near-instant hold would keep the whole suite green while making
    // accidental deletion easy.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onRemove = vi.fn();
    render(<TaskEditor value={[emptyTaskDraft()]} onChange={vi.fn()} onRemove={onRemove} canTick />);
    const removeButton = screen.getByLabelText('Remove task');

    await act(async () => {
      fireEvent.pointerDown(removeButton);
      await vi.advanceTimersByTimeAsync(900);
    });
    expect(onRemove).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(onRemove).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('a short press on the remove button does not call onRemove', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onRemove = vi.fn();
    render(<TaskEditor value={[emptyTaskDraft()]} onChange={vi.fn()} onRemove={onRemove} canTick />);
    const removeButton = screen.getByLabelText('Remove task');

    await act(async () => {
      fireEvent.pointerDown(removeButton);
      await vi.advanceTimersByTimeAsync(200);
      fireEvent.pointerUp(removeButton);
    });

    expect(onRemove).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('TaskRow', () => {
  it('renders the fallback name for an empty title, then the typed title', () => {
    const onChangeSpy = vi.fn();
    render(<ControlledTaskRow initial={emptyTaskDraft()} onChangeSpy={onChangeSpy} />);

    expect(screen.getByRole('heading', { name: 'Task 1' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Optional title'), { target: { value: 'Bracket mount' } });

    expect(screen.getByRole('heading', { name: 'Bracket mount' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Task 1' })).not.toBeInTheDocument();
  });

  it('the task total reflects the enabled services', () => {
    const task: TaskDraft = {
      ...emptyTaskDraft(),
      scanCost: 1000,
      modelisationCost: 500,
      usinageCost: null,
      impressionCost: null,
    };
    render(
      <TaskRow
        task={task}
        index={0}
        onChange={vi.fn()}
        onRemove={vi.fn()}
        expanded
        onToggle={vi.fn()}
        // Edit mode, because the task-total row being asserted on below is
        // part of the raw form (still in TaskRow verbatim until Task 11
        // moves it into TaskStepFields) — the read-only TaskStepList shows
        // per-step costs, not the aggregate.
        editing
        onToggleEdit={vi.fn()}
        canTick
      />,
    );

    expect(taskTotal(task)).toBe(1500);
    // getByText's default normalizer collapses all whitespace (including the
    // thin space formatMoney uses as a thousands separator) to a single
    // ASCII space before matching — do the same to the expected string, or
    // an exact-looking match still misses.
    const expected = formatMoney(taskTotal(task), 'USD').replace(/\s+/g, ' ');
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('typing a Scan cost emits scanCost set; clearing it emits null, not 0', () => {
    // This is the test Step 5 of the brief requires proving can fail: making
    // the clear path in TaskRow's CostInput emit `0` instead of `null` must
    // turn this test red, since `0` (a free service) and `null` (a disabled
    // one) are not interchangeable anywhere else in the stack.
    const onChangeSpy = vi.fn();
    render(<ControlledTaskRow initial={emptyTaskDraft()} onChangeSpy={onChangeSpy} />);
    const scanInput = screen.getByLabelText('Scan Cost');

    fireEvent.change(scanInput, { target: { value: '15' } });
    expect(onChangeSpy).toHaveBeenLastCalledWith(expect.objectContaining({ scanCost: 15 }));

    fireEvent.change(scanInput, { target: { value: '' } });
    const lastCall = onChangeSpy.mock.calls.at(-1)?.[0] as TaskDraft;
    expect(lastCall.scanCost).toBeNull();
    expect(lastCall.scanCost).not.toBe(0);
  });

  it('typing a Printing cost emits impressionCost set; clearing it emits null, not 0', () => {
    // Impression3D's cost is now a field the user can type into, not only a
    // figure the calculator derives. Same null-vs-zero rule as the other three
    // services: empty means the service is disabled, 0 means it is free.
    const onChangeSpy = vi.fn();
    render(<ControlledTaskRow initial={emptyTaskDraft()} onChangeSpy={onChangeSpy} />);
    const costInput = screen.getByLabelText('Printing Cost');

    fireEvent.change(costInput, { target: { value: '4200' } });
    expect(onChangeSpy).toHaveBeenLastCalledWith(expect.objectContaining({ impressionCost: 4200 }));

    fireEvent.change(costInput, { target: { value: '' } });
    const lastCall = onChangeSpy.mock.calls.at(-1)?.[0] as TaskDraft;
    expect(lastCall.impressionCost).toBeNull();
    expect(lastCall.impressionCost).not.toBe(0);
  });

  it('editing a print field on an imported task does not clear its cost', async () => {
    // An imported task carries the quote's price but no printer or filament —
    // the quote names a material in prose, not a calculator filament id. So
    // computeImpressionCost returns null for it. Reporting that null would not
    // blank the field, it would DISABLE the service: null is "off", which
    // drops the badge and the amount from the project total. The calculator
    // may only write a cost it was actually able to compute.
    const onChangeSpy = vi.fn();
    const imported: TaskDraft = {
      ...emptyTaskDraft(),
      id: 7,
      impression: { printerId: null, filamentId: null, weightG: 210, timeMin: 780, quantity: 1, color: 'Noir' },
      impressionCost: 2400,
    };
    render(<ControlledTaskRow initial={imported} onChangeSpy={onChangeSpy} />);

    fireEvent.change(await screen.findByLabelText(/colou?r/i), { target: { value: 'Rouge' } });

    const lastCall = onChangeSpy.mock.calls.at(-1)?.[0] as TaskDraft;
    expect(lastCall.impression.color).toBe('Rouge');
    expect(lastCall.impressionCost).toBe(2400);
  });

  it('does not stomp a hand-typed cost after a print field was edited', async () => {
    // The bug the old useEffect had: it re-fired on every render (TaskRow hands
    // ImpressionFields a fresh callback identity each time), so once a print
    // field had been touched, any later render reported the COMPUTED total and
    // overwrote whatever the user had typed into Cost.
    const onChangeSpy = vi.fn();
    const user = userEvent.setup();
    render(<ControlledTaskEditor initial={[emptyTaskDraft()]} onChangeSpy={onChangeSpy} />);
    await expandTask();
    await editTask();

    await user.click(await screen.findByRole('combobox', { name: /printer/i }));
    await user.click(await screen.findByRole('option', { name: 'H2S' }));
    await user.click(screen.getByRole('combobox', { name: /material/i }));
    await user.click(await screen.findByRole('option', { name: 'Sunlu PA6-CF' }));
    await user.type(screen.getByLabelText(/weight/i), '40');
    await user.type(screen.getByLabelText(/print time/i), '1');

    await waitFor(() => {
      const tasks = onChangeSpy.mock.calls.at(-1)?.[0] as TaskDraft[] | undefined;
      expect(tasks?.[0].impressionCost).not.toBeNull();
    });

    fireEvent.change(screen.getByLabelText('Printing Cost'), { target: { value: '999' } });

    // Give every pending render and query a chance to flush. Under the old
    // effect the computed total lands here and 999 is gone.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const tasks = onChangeSpy.mock.calls.at(-1)?.[0] as TaskDraft[];
    expect(tasks[0].impressionCost).toBe(999);
  });

  it('drives Printing end to end and settles without a runaway onChange loop', async () => {
    // ImpressionFields reports its price from its change handler, once per
    // edit — not from an effect that re-fires on every render. This test
    // wires printer/material/weight/time through to a real cost and then
    // proves the tree goes quiet: the onChange count must hold steady rather
    // than grow. It is the only test here that drives ImpressionFields' own
    // inputs, so it is the only one that would catch a regression back to
    // effect-based reporting.
    const onChangeSpy = vi.fn();
    const user = userEvent.setup();
    render(<ControlledTaskEditor initial={[emptyTaskDraft()]} onChangeSpy={onChangeSpy} />);
    await expandTask();
    await editTask();

    await user.click(await screen.findByRole('combobox', { name: /printer/i }));
    await user.click(await screen.findByRole('option', { name: 'H2S' }));

    await user.click(screen.getByRole('combobox', { name: /material/i }));
    await user.click(await screen.findByRole('option', { name: 'Sunlu PA6-CF' }));

    await user.type(screen.getByLabelText(/weight/i), '40');
    // DurationInput only gives its `id` (and therefore an accessible name) to
    // the days field — see the note against querying hours/minutes by name.
    // One day is far more than enough to make `timeMin` non-null.
    await user.type(screen.getByLabelText(/print time/i), '1');

    await waitFor(() => {
      const lastTasks = onChangeSpy.mock.calls.at(-1)?.[0] as TaskDraft[] | undefined;
      expect(lastTasks?.[0].impressionCost).not.toBeNull();
    });

    const settledCallCount = onChangeSpy.mock.calls.length;

    // With the guard in place, giving the tree more time to flush is a no-op.
    // Without it, onChange keeps firing here — the count grows instead of
    // holding steady (or the test times out first, in an unguarded infinite
    // synchronous loop).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(onChangeSpy.mock.calls.length).toBe(settledCallCount);
  });

  it('opening a task with a stored cost and touching nothing issues zero onChange calls, even though today\'s rates would recompute a different total', async () => {
    // Regression for the "opening the detail panel silently rewrites every
    // saved impression_cost" bug. Pricing now happens only in the change
    // handler, so a mount cannot report anything — but this test is what
    // pins that down: mockDefaults differ sharply from the stored 12345, so
    // any recompute-on-mount would be visible immediately. Nothing here is a
    // user edit, so onChange must never fire.
    const onChangeSpy = vi.fn();
    const task: TaskDraft = {
      ...emptyTaskDraft(),
      id: 42,
      impression: { printerId: 1, filamentId: 1, weightG: 40, timeMin: 60, quantity: 1, color: 'Noir' },
      impressionCost: 12345,
    };
    render(<ControlledTaskRow initial={task} onChangeSpy={onChangeSpy} />);

    // Give every query (filaments, printers, defaults, settings) every chance
    // to resolve. Pricing only happens inside ImpressionFields' change
    // handler now, so mounting alone should never report anything — this
    // window is here to be sure nothing async sneaks in after mount either.
    await screen.findByRole('combobox', { name: /printer/i });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(onChangeSpy).not.toHaveBeenCalled();
  });

  it('opening a task whose printer reference is absent from the calculator list issues zero onChange calls and leaves the stored cost untouched', async () => {
    // The `impression_printer_id` isn't a foreign key (see aito_task.py's
    // docstring): a printer deleted from the calculator must not corrupt a
    // frozen historical quote. computeImpressionCost returns null forever for
    // a dangling reference, so the old unguarded effect would report `null`
    // on mount and destroy the stored figure.
    const onChangeSpy = vi.fn();
    const task: TaskDraft = {
      ...emptyTaskDraft(),
      id: 43,
      impression: { printerId: 999, filamentId: 1, weightG: 40, timeMin: 60, quantity: 1, color: 'Noir' },
      impressionCost: 12345,
    };
    render(<ControlledTaskRow initial={task} onChangeSpy={onChangeSpy} />);

    await screen.findByRole('combobox', { name: /material/i });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(onChangeSpy).not.toHaveBeenCalled();
  });

  it('reports the quantity-multiplied total (total_ttc_qty), not the per-unit total_ttc', async () => {
    // Pins the decision at ImpressionFields.tsx: which PricingResult field
    // gets reported as `computedCost` through its `onChange` prop. Every
    // other test that reaches impressionCost uses quantity 1, where
    // total_ttc and total_ttc_qty are equal, so this is the only test that
    // would go red if that line were changed to report the per-unit figure
    // instead.
    const onChangeSpy = vi.fn();
    const user = userEvent.setup();
    render(<ControlledTaskEditor initial={[emptyTaskDraft()]} onChangeSpy={onChangeSpy} />);
    await expandTask();
    await editTask();

    await user.click(await screen.findByRole('combobox', { name: /printer/i }));
    await user.click(await screen.findByRole('option', { name: 'H2S' }));
    await user.click(screen.getByRole('combobox', { name: /material/i }));
    await user.click(await screen.findByRole('option', { name: 'Sunlu PA6-CF' }));
    await user.type(screen.getByLabelText(/weight/i), '40');
    await user.type(screen.getByLabelText(/print time/i), '1');

    await waitFor(() => {
      const lastTasks = onChangeSpy.mock.calls.at(-1)?.[0] as TaskDraft[] | undefined;
      expect(lastTasks?.[0].impressionCost).not.toBeNull();
    });
    const quantityOneCost = (onChangeSpy.mock.calls.at(-1)?.[0] as TaskDraft[])[0].impressionCost as number;

    onChangeSpy.mockClear();
    const quantityInput = screen.getByLabelText('Quantity');
    fireEvent.change(quantityInput, { target: { value: '2' } });

    await waitFor(() => {
      const lastTasks = onChangeSpy.mock.calls.at(-1)?.[0] as TaskDraft[] | undefined;
      expect(lastTasks?.[0].impressionCost).not.toBeNull();
      expect(lastTasks?.[0].impressionCost).toBeCloseTo(quantityOneCost * 2, 6);
    });
  });
});
