/**
 * Tests for TaskRow and TaskEditor — the presentational task-list UI for an
 * Aito project. Both components are fully controlled (no internal state, no
 * persistence), so most tests either drive a stateful harness that mirrors
 * what a real caller (create modal / detail panel) would do, or assert
 * directly on the arguments passed to `onChange`.
 */

import { useState } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent, act, waitFor, within } from '@testing-library/react';
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
  // Editing, because these tests are about the fields inside a row (title,
  // description, the four cost inputs, ImpressionFields), which only render
  // in edit mode — not about the read/edit split itself, which has its own
  // tests below.
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
  accordion = false,
}: {
  initial: TaskDraft[];
  onChangeSpy: (next: TaskDraft[]) => void;
  accordion?: boolean;
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
      accordion={accordion}
    />
  );
}

/** Same wiring as `ControlledTaskEditor`, but `onRemove` actually splices the
 *  index out of the array instead of being a stub — the way `NewProjectDrawer`
 *  and the detail panel both wire it. Needed for tests that check what
 *  happens to `TaskEditor`'s own row-keyed state (`editingKeys`, `openKey`)
 *  when a row disappears via removal, as opposed to `ControlledTaskEditor` +
 *  a manual `onChange` swap (used by the "wipe draft" test) which never goes
 *  through `onRemove` at all. */
function RemovableTaskEditor({ initial, accordion = false }: { initial: TaskDraft[]; accordion?: boolean }) {
  const [tasks, setTasks] = useState(initial);
  return (
    <TaskEditor
      value={tasks}
      onChange={setTasks}
      onRemove={(index) => setTasks((current) => current.filter((_, i) => i !== index))}
      canTick
      accordion={accordion}
    />
  );
}

/** Switches a row into edit mode, revealing the raw
 *  title/description/cost/ImpressionFields form in place of the read-only
 *  step list. Only needed for a row that already has a step — a stepless row
 *  has no Edit button at all (see TaskRow: it IS the form already, so there
 *  is nothing else to switch to). `index` disambiguates by position when more
 *  than one row is on screen. */
async function editTask(index = 0) {
  const buttons = await screen.findAllByRole('button', { name: /edit task/i });
  fireEvent.click(buttons[index]);
}

/** Opens ImpressionFields' calculator, hidden by default behind its toggle so
 *  the printing block opens compact — the six pricing fields and the cost
 *  breakdown only render behind this click. */
async function openCalculator() {
  fireEvent.click(await screen.findByRole('button', { name: 'Calculator' }));
}

/** Mounts TaskEditor uncontrolled with the given draft tasks, all of which
 *  start in edit mode (a stepless task IS the form — see TaskEditor's
 *  `isEditing`). For tests that only need to observe DOM after a click, not
 *  round-trip state through a controlled harness. */
function renderEditor(tasks: TaskDraft[]) {
  render(<TaskEditor value={tasks} onChange={vi.fn()} onRemove={vi.fn()} canTick />);
}

/** Same as `renderEditor`, but hands back the `onChange` spy so a test can
 *  inspect the array TaskEditor reports upward. */
function renderEditorAndCaptureOnChange(tasks: TaskDraft[]) {
  const onChange = vi.fn();
  render(<TaskEditor value={tasks} onChange={onChange} onRemove={vi.fn()} canTick />);
  return onChange;
}

/** Pulls task index 0 out of the most recent `onChange` call TaskEditor made
 *  — every test using this only ever mounts a single task row. */
function lastChangedTask(onChange: ReturnType<typeof vi.fn>): TaskDraft {
  const calls = onChange.mock.calls as TaskDraft[][][];
  return calls[calls.length - 1][0][0];
}

describe('TaskEditor', () => {
  it('starts with chips only and reveals a price input when a service chip is enabled', async () => {
    renderEditor([emptyTaskDraft()]);
    // No cost inputs while every service is disabled:
    expect(screen.queryByLabelText(/Scan.*cost/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add Scan' }));
    const input = screen.getByLabelText(/Scan.*cost/i);
    expect(input).toHaveValue(null); // enabling does NOT invent a price
  });

  it('disabling a chip clears the cost to null', async () => {
    // scanCost is non-null, so this task already has a step — it starts
    // read-only (TaskStepList), same as every other priced-row test in this
    // file. Edit first to reach the chip.
    const task = { ...emptyTaskDraft(), scanCost: 45 };
    const onChange = renderEditorAndCaptureOnChange([task]);
    await userEvent.click(screen.getByRole('button', { name: /edit task/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove Scan' }));
    expect(lastChangedTask(onChange).scanCost).toBeNull();
  });

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
    // A stepless task IS the form already — no expand/edit click needed, but
    // every service still starts as a chip: enable Scan to reach its cost.
    fireEvent.click(screen.getByRole('button', { name: 'Add Scan' }));

    fireEvent.change(screen.getByLabelText('Scan Cost'), { target: { value: '7' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    const result = onChange.mock.calls[0][0] as TaskDraft[];
    expect(result).not.toBe(value);
    // The original array and its entries are untouched.
    expect(value[0].scanCost).toBeNull();
    expect(result[0].scanCost).toBe(7);
  });

  it('renders a priced row read-only, as a step list with a total and a remove control, no form', async () => {
    const task: TaskDraft = { ...emptyTaskDraft(), title: 'Boîtier', scanCost: 4000, usinageCost: 500 };
    render(<TaskEditor value={[task]} onChange={vi.fn()} onRemove={vi.fn()} canTick />);

    // Visible: the name, the step list (one entry per priced service, plus
    // its own per-step cost), and the remove control.
    expect(await screen.findByRole('heading', { name: /^Boîtier/ })).toBeInTheDocument();
    expect(screen.getByText('Scan')).toBeInTheDocument();
    expect(screen.getByText('Machining')).toBeInTheDocument();
    expect(screen.getByLabelText('Remove task')).toBeInTheDocument();

    // A service left disabled has no entry, and the row is read-only — the
    // raw form fields are not reachable without pressing Edit first.
    expect(screen.queryByText('Modeling')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Scan Cost')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Optional title')).not.toBeInTheDocument();
  });

  it('a free service still appears in the read-only step list', async () => {
    // null disables a service, 0 prices it at nothing. A step list built on
    // truthiness instead of a null check would silently drop this one.
    const task: TaskDraft = { ...emptyTaskDraft(), title: 'Gratuit', scanCost: 0 };
    render(<TaskEditor value={[task]} onChange={vi.fn()} onRemove={vi.fn()} canTick />);

    expect(await screen.findByText('Scan')).toBeInTheDocument();
  });

  it('editing one row leaves its neighbour read-only', async () => {
    // Guards the agreement between a row's React key and its editing key: if
    // those ever diverge, opening one row's edit form would open another's.
    const tasks = [
      { ...emptyTaskDraft(), title: 'Un', scanCost: 10 },
      { ...emptyTaskDraft(), title: 'Deux', scanCost: 20 },
    ];
    render(<TaskEditor value={tasks} onChange={vi.fn()} onRemove={vi.fn()} canTick />);

    // Both rows already have a step, so both start read-only — edit Deux
    // (index 1) only.
    await editTask(1);

    // Exactly one body is in edit mode.
    expect(screen.getAllByLabelText('Optional title')).toHaveLength(1);
    // Un is untouched, still showing its own step read-only.
    expect(screen.getByRole('heading', { name: /^Un/ })).toBeInTheDocument();
  });

  it('a task added with "+ Add task" opens as the form — it has no steps yet', async () => {
    const user = userEvent.setup();
    render(<ControlledTaskEditor initial={[]} onChangeSpy={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /add task/i }));

    expect(await screen.findByRole('heading', { name: /^Task 1/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Optional title')).toBeInTheDocument();
  });

  it('adding a second task leaves an already-priced first task read-only', async () => {
    const user = userEvent.setup();
    const priced: TaskDraft = { ...emptyTaskDraft(), title: 'Priced', scanCost: 10 };
    render(<ControlledTaskEditor initial={[priced]} onChangeSpy={vi.fn()} />);

    // The pre-existing, already-priced row stays read-only; only the new
    // stepless one opens as a form.
    await user.click(screen.getByRole('button', { name: /add task/i }));

    expect(await screen.findByRole('heading', { name: /^Task 2/ })).toBeInTheDocument();
    expect(screen.getAllByLabelText('Optional title')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: /^Priced/ })).toBeInTheDocument();
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

  it('removing a row does not disturb another row that is also being edited', async () => {
    // Characterizes `editingKeys` before the removal-pruning change: the set
    // can hold more than one row's key at once (edit is per-row, not
    // exclusive outside accordion mode), and removing one row must drop only
    // that row's own key, leaving a sibling's edit state alone. This is the
    // regression guard for Task T-024's prune — a prune that targeted the
    // wrong key (e.g. an off-by-one against the pre-removal index) would
    // surface here as Deux silently losing its edit form.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const tasks = [
      { ...emptyTaskDraft(), title: 'Un', scanCost: 10 },
      { ...emptyTaskDraft(), title: 'Deux', scanCost: 20 },
    ];
    render(<RemovableTaskEditor initial={tasks} />);

    await editTask(0);
    await editTask(1);
    expect(screen.getAllByLabelText('Optional title')).toHaveLength(2);

    const removeButtons = screen.getAllByLabelText('Remove task');
    await act(async () => {
      fireEvent.pointerDown(removeButtons[0]);
      await vi.advanceTimersByTimeAsync(1000);
    });
    vi.useRealTimers();

    // Un is gone, Deux (now at index 0) is still mid-edit.
    expect(screen.getByRole('heading', { name: /^Deux/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^Un/ })).not.toBeInTheDocument();
    expect(screen.getAllByLabelText('Optional title')).toHaveLength(1);
  });

  it('shows its own "Tasks / Project total" header by default, so NewProjectModal is unaffected', () => {
    const task: TaskDraft = { ...emptyTaskDraft(), scanCost: 10 };
    render(<TaskEditor value={[task]} onChange={vi.fn()} onRemove={vi.fn()} canTick />);
    expect(screen.getByRole('heading', { name: 'Tasks' })).toBeInTheDocument();
    expect(screen.getByText('Project total')).toBeInTheDocument();
  });

  it('hides its own header when showHeader is false — the detail panel renders its own "Work" header instead', () => {
    const task: TaskDraft = { ...emptyTaskDraft(), scanCost: 10 };
    render(<TaskEditor value={[task]} onChange={vi.fn()} onRemove={vi.fn()} canTick showHeader={false} />);
    expect(screen.queryByRole('heading', { name: 'Tasks' })).not.toBeInTheDocument();
    expect(screen.queryByText('Project total')).not.toBeInTheDocument();
  });
});

describe('TaskRow', () => {
  it('renders the fallback name for an empty title, then the typed title', () => {
    const onChangeSpy = vi.fn();
    render(<ControlledTaskRow initial={emptyTaskDraft()} onChangeSpy={onChangeSpy} />);

    // The heading also carries the (zero) total now, hence a regex rather
    // than an exact string.
    expect(screen.getByRole('heading', { name: /^Task 1/ })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Optional title'), { target: { value: 'Bracket mount' } });

    expect(screen.getByRole('heading', { name: /^Bracket mount/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^Task 1/ })).not.toBeInTheDocument();
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
        // Edit mode, because the task-total row being asserted on below is
        // part of the raw form (TaskStepFields) — the read-only TaskStepList
        // shows per-step costs, not the aggregate.
        editing
        onToggleEdit={vi.fn()}
        canTick
      />,
    );

    expect(taskTotal(task)).toBe(1500);
    // getByText's default normalizer collapses all whitespace (including the
    // thin space formatMoney uses as a thousands separator) to a single
    // ASCII space before matching — do the same to the expected string, or
    // an exact-looking match still misses. It appears twice now: once in the
    // always-visible header, once in TaskStepFields' own total footer.
    const expected = formatMoney(taskTotal(task), 'USD').replace(/\s+/g, ' ');
    expect(screen.getAllByText(expected)).toHaveLength(2);
  });

  it('typing a Scan cost emits scanCost set; clearing it emits null, not 0', () => {
    // This is the test Step 5 of the brief requires proving can fail: making
    // the clear path in TaskRow's CostInput emit `0` instead of `null` must
    // turn this test red, since `0` (a free service) and `null` (a disabled
    // one) are not interchangeable anywhere else in the stack.
    const onChangeSpy = vi.fn();
    render(<ControlledTaskRow initial={emptyTaskDraft()} onChangeSpy={onChangeSpy} />);
    // Every service starts as a chip on an empty draft; enable Scan first.
    fireEvent.click(screen.getByRole('button', { name: 'Add Scan' }));
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
    // Every service starts as a chip on an empty draft; enable Printing first.
    fireEvent.click(screen.getByRole('button', { name: 'Add Printing' }));
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
    await openCalculator();

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
    // A stepless task IS the form already — no expand/edit click needed, but
    // Printing is still a chip on an empty draft: enable it to reveal
    // ImpressionFields.
    await user.click(screen.getByRole('button', { name: 'Add Printing' }));
    await openCalculator();

    await user.click(await screen.findByRole('combobox', { name: /printer/i }));
    await user.click(await screen.findByRole('option', { name: 'H2S' }));
    await user.click(screen.getByRole('combobox', { name: /material/i }));
    await user.click(await screen.findByRole('option', { name: 'Sunlu PA6-CF' }));
    await user.type(screen.getByLabelText(/weight/i), '40');
    await user.type(screen.getByRole('spinbutton', { name: /days/i }), '1');

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
    // A stepless task IS the form already — no expand/edit click needed, but
    // Printing is still a chip on an empty draft: enable it to reveal
    // ImpressionFields.
    await user.click(screen.getByRole('button', { name: 'Add Printing' }));
    await openCalculator();

    await user.click(await screen.findByRole('combobox', { name: /printer/i }));
    await user.click(await screen.findByRole('option', { name: 'H2S' }));

    await user.click(screen.getByRole('combobox', { name: /material/i }));
    await user.click(await screen.findByRole('option', { name: 'Sunlu PA6-CF' }));

    await user.type(screen.getByLabelText(/weight/i), '40');
    // Every segment now carries its own aria-label, so target days directly
    // rather than the group's "Print time" label. One day is far more than
    // enough to make `timeMin` non-null.
    await user.type(screen.getByRole('spinbutton', { name: /days/i }), '1');

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
    // Opening the calculator is a disclosure click, not an edit — it must not
    // produce an onChange either.
    await openCalculator();

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
    await openCalculator();

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
    // A stepless task IS the form already — no expand/edit click needed, but
    // Printing is still a chip on an empty draft: enable it to reveal
    // ImpressionFields.
    await user.click(screen.getByRole('button', { name: 'Add Printing' }));
    await openCalculator();

    await user.click(await screen.findByRole('combobox', { name: /printer/i }));
    await user.click(await screen.findByRole('option', { name: 'H2S' }));
    await user.click(screen.getByRole('combobox', { name: /material/i }));
    await user.click(await screen.findByRole('option', { name: 'Sunlu PA6-CF' }));
    await user.type(screen.getByLabelText(/weight/i), '40');
    await user.type(screen.getByRole('spinbutton', { name: /days/i }), '1');

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

  it('printing: quantity sits beside the cost; the calculator hides behind its toggle, divider included', async () => {
    const task = {
      ...emptyTaskDraft(),
      impression: { printerId: 1, filamentId: 1, weightG: 40, timeMin: 60, quantity: 1, color: 'Noir' },
      impressionCost: 500,
    };
    render(<ControlledTaskRow initial={task} onChangeSpy={vi.fn()} />);

    // Closed by default — even with every parameter filled: the block opens
    // compact. Printer/weight/time stay behind the toggle (material moved to
    // the always-visible detail row, so it is deliberately NOT checked here).
    expect(screen.queryByRole('combobox', { name: /printer/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/weight/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('impression-divider')).not.toBeInTheDocument();
    // Both fields are co-located in the top row — quantity is no longer
    // buried in the calculator's parameter grid.
    const topRow = within(screen.getByTestId('impression-top-row'));
    topRow.getByLabelText(/printing cost/i);
    topRow.getByLabelText('Quantity');

    await openCalculator();
    await screen.findByRole('combobox', { name: /printer/i });
    expect(screen.getByTestId('impression-divider')).toBeInTheDocument();
  });
});

describe('TaskEditor accordion (create drawer)', () => {
  const priced = (title: string): TaskDraft => ({ ...emptyTaskDraft(), title, scanCost: 10 });

  function renderAccordion(tasks: TaskDraft[]) {
    render(<TaskEditor value={tasks} onChange={vi.fn()} onRemove={vi.fn()} canTick={false} accordion />);
  }

  it('opens the first task and collapses the rest', () => {
    renderAccordion([priced('Alpha'), priced('Beta')]);
    expect(screen.getByRole('button', { name: /Alpha/, expanded: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Beta/, expanded: false })).toBeInTheDocument();
    // The collapsed row's body — its progress included — is not rendered.
    expect(screen.getByTestId('task-progress-0')).toBeInTheDocument();
    expect(screen.queryByTestId('task-progress-1')).not.toBeInTheDocument();
  });

  it('clicking a collapsed header opens it and collapses the previously open task', async () => {
    renderAccordion([priced('Alpha'), priced('Beta')]);
    await userEvent.click(screen.getByRole('button', { name: /Beta/, expanded: false }));
    expect(screen.getByRole('button', { name: /Beta/, expanded: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Alpha/, expanded: false })).toBeInTheDocument();
    expect(screen.queryByTestId('task-progress-0')).not.toBeInTheDocument();
    expect(screen.getByTestId('task-progress-1')).toBeInTheDocument();
  });

  it('clicking the open header closes it — zero open is allowed', async () => {
    renderAccordion([priced('Alpha'), priced('Beta')]);
    await userEvent.click(screen.getByRole('button', { name: /Alpha/, expanded: true }));
    expect(screen.getByRole('button', { name: /Alpha/, expanded: false })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Beta/, expanded: false })).toBeInTheDocument();
  });

  it('"Add task" opens the new task and collapses the rest', async () => {
    render(<ControlledTaskEditor initial={[priced('Alpha')]} onChangeSpy={vi.fn()} accordion />);
    await userEvent.click(screen.getByRole('button', { name: /add task/i }));
    // The new stepless row is the form: its service chips are on screen.
    expect(screen.getByRole('button', { name: 'Add Scan' })).toBeInTheDocument();
    // Alpha (index 0) collapsed: its progress is gone.
    expect(screen.getByRole('button', { name: /Alpha/, expanded: false })).toBeInTheDocument();
    expect(screen.queryByTestId('task-progress-0')).not.toBeInTheDocument();
  });

  it('the pencil on a collapsed row expands it straight into edit mode', async () => {
    render(<ControlledTaskEditor initial={[priced('Alpha'), priced('Beta')]} onChangeSpy={vi.fn()} accordion />);
    const pencils = screen.getAllByRole('button', { name: /edit task/i });
    await userEvent.click(pencils[1]);
    expect(screen.getByRole('button', { name: /Beta/, expanded: true })).toBeInTheDocument();
    // Edit mode, not the read-only step list: Beta's chip row is on screen.
    expect(screen.getByRole('button', { name: 'Remove Scan' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Alpha/, expanded: false })).toBeInTheDocument();
  });

  it('a stepless task collapses like any other — only the open task shows its form', () => {
    // Alpha is seeded open; the unpriced draft behind it must fold to its
    // header line too, or a drawer full of unpriced drafts is a wall of forms
    // — the exact problem accordion mode exists to solve.
    renderAccordion([priced('Alpha'), { ...emptyTaskDraft(), title: 'Empty' }]);
    expect(screen.queryByRole('button', { name: 'Add Scan' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Empty/, expanded: false })).toBeInTheDocument();
  });

  it('expanding a collapsed stepless task reveals its form', async () => {
    renderAccordion([priced('Alpha'), { ...emptyTaskDraft(), title: 'Empty' }]);
    await userEvent.click(screen.getByRole('button', { name: /Empty/, expanded: false }));
    expect(screen.getByRole('button', { name: 'Add Scan' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Alpha/, expanded: false })).toBeInTheDocument();
  });

  it('when the open row vanishes (drawer reset swaps in fresh drafts), the first row opens', async () => {
    // Mirrors NewProjectDrawer's hold-to-reset: setTasks replaces the array
    // with drafts whose uids can never match the stored openKey. The dangling
    // key must fall back to the first row, or the fresh draft's form would be
    // unreachable behind a bare header.
    function ResettableEditor() {
      const [tasks, setTasks] = useState<TaskDraft[]>([priced('Alpha')]);
      return (
        <>
          <button type="button" onClick={() => setTasks([emptyTaskDraft()])}>
            wipe draft
          </button>
          <TaskEditor value={tasks} onChange={setTasks} onRemove={vi.fn()} canTick={false} accordion />
        </>
      );
    }
    render(<ResettableEditor />);
    await userEvent.click(screen.getByRole('button', { name: 'wipe draft' }));
    expect(screen.getByRole('button', { name: 'Add Scan' })).toBeInTheDocument();
  });

  it('when the open row is removed outright, the remaining row opens', async () => {
    // Same `effectiveOpenKey` fallback as the "wipe draft" test above, but
    // reached through an actual removal (`onRemove`, wired for real by
    // `RemovableTaskEditor`) rather than a full-array swap via `onChange`.
    // This is the path Task T-024's prune touches, and it must keep landing
    // on the same row the unpruned code already opens: `effectiveOpenKey`
    // derives its fallback from `openKey` and `value` alone, never from
    // `editingKeys`, so pruning the latter has nothing to do with which row
    // this resolves to — characterizing it here pins that down before the
    // change, not just after.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<RemovableTaskEditor initial={[priced('Alpha'), priced('Beta')]} accordion />);

    // Alpha (index 0) starts open (accordion seeds `openKey` to the first
    // row). Remove it.
    const removeButtons = screen.getAllByLabelText('Remove task');
    await act(async () => {
      fireEvent.pointerDown(removeButtons[0]);
      await vi.advanceTimersByTimeAsync(1000);
    });
    vi.useRealTimers();

    // Only Beta remains. The stored `openKey` (Alpha's) now matches no row,
    // so the dangling-key fallback opens the sole survivor.
    expect(screen.getByRole('button', { name: /Beta/, expanded: true })).toBeInTheDocument();
    expect(screen.getByTestId('task-progress-0')).toBeInTheDocument();
  });

  it('without accordion, headers are not disclosure buttons — the detail panel is untouched', () => {
    renderEditor([priced('Alpha'), priced('Beta')]);
    expect(screen.queryByRole('button', { name: /Alpha/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('task-progress-0')).toBeInTheDocument();
    expect(screen.getByTestId('task-progress-1')).toBeInTheDocument();
  });
});
