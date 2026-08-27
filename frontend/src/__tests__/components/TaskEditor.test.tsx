/**
 * Tests for TaskRow and TaskEditor — the presentational task-list UI for an
 * Aito project. Both components are fully controlled (no internal state, no
 * persistence), so most tests either drive a stateful harness that mirrors
 * what a real caller (create modal / detail panel) would do, or assert
 * directly on the arguments passed to `onChange`.
 */

import { useState } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent, act, waitFor, within, render as rtlRender } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { server } from '../mocks/server';
import { render } from '../utils';
import { ToastProvider } from '../../contexts/ToastContext';
import { TaskRow } from '../../components/aito/TaskRow';
import { TaskEditor, reorderedTasks } from '../../components/aito/TaskEditor';
import { computeImpressionCost, emptyTaskDraft, roundUpTo50, rowKey, taskTotal } from '../../utils/taskDraft';
import type { TaskDraft } from '../../utils/taskDraft';
import { formatMoney } from '../../utils/pricing';

/** Captures `TaskEditor`'s `onDragEnd` prop to `DndContext` so a test can call
 *  it directly with a synthetic `DragEndEvent` shape, the same pattern
 *  `AitoBoardDragFailure.test.tsx` and `AitoPageDragLock.test.tsx` use — jsdom
 *  has no `PointerEvent` (confirmed in `AitoBoardColumnDrag.test.tsx`'s header
 *  comment), so a real pointer drag cannot be dispatched and observed here.
 *  This is the only way to exercise `handleDragEnd` → `onReorder` (the pure
 *  reorder math already has its own tests above, via the exported
 *  `reorderedTasks`) without exporting `handleDragEnd` itself from
 *  TaskEditor.tsx, which the brief rules out.
 *
 *  Vitest hoists `vi.mock` above module-level `const`s, so the factory below
 *  can only safely close over a variable named with the `mock` prefix — see
 *  https://vitest.dev/api/vi.html#vi-mock. */
const mockCapturedOnDragEnd: {
  current?: (e: { active: { id: string }; over: { id: string } | null }) => void;
} = {};

vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: (props: {
      children: React.ReactNode;
      onDragEnd?: typeof mockCapturedOnDragEnd.current;
    }) => {
      mockCapturedOnDragEnd.current = props.onDragEnd;
      return props.children;
    },
  };
});

const mockFilaments = [
  {
    id: 1,
    name: 'Sunlu PA6-CF',
    brand: 'Sunlu',
    material: 'PA6-CF',
    cost_per_kg: 3731,
    // Derived server-side: round(3731 * 1.50, 2).
    sale_price_per_kg: 5596.5,
    margin_pct: 50,
    difficulty_pct: 150,
    zoho_item_id: null,
    zoho_item_name: null,
    zoho_sku: null,
    spool_weight_kg: null,
    zoho_synced_at: null,
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

/** Same wiring as `render(<ControlledTaskRow .../>)`, but with the
 *  `QueryClient` mounted OUTSIDE the tree so a test can force a background
 *  refetch on it directly (`client.refetchQueries`) rather than waiting on
 *  `staleTime`/window-focus semantics neither jsdom nor fake timers model
 *  cleanly. */
function renderControlledTaskRowWithClient(initial: TaskDraft, onChangeSpy: (next: TaskDraft) => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  rtlRender(
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <ToastProvider>
          <ControlledTaskRow initial={initial} onChangeSpy={onChangeSpy} />
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>,
  );
  return client;
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
 *  happens to `TaskEditor`'s own row-keyed state (`editingKey`, `openKey`)
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

  it('editing a second row closes the first one — one open form at a time', async () => {
    // The detail panel's task column is a single scroll region, and an open
    // edit form is several times the height of the read-only step list it
    // replaces. Two of them at once pushes every other task off screen, so
    // edit is exclusive: opening one closes whichever was open.
    const tasks = [
      { ...emptyTaskDraft(), title: 'Un', scanCost: 10 },
      { ...emptyTaskDraft(), title: 'Deux', scanCost: 20 },
    ];
    render(<TaskEditor value={tasks} onChange={vi.fn()} onRemove={vi.fn()} canTick />);

    await editTask(0);
    expect(screen.getByDisplayValue('Un')).toBeInTheDocument();

    await editTask(1);

    // Exactly one form, and it is Deux's — Un fell back to its step list.
    expect(screen.getAllByLabelText('Optional title')).toHaveLength(1);
    expect(screen.getByDisplayValue('Deux')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Un')).not.toBeInTheDocument();
  });

  it('the pencil still closes the row it opened', async () => {
    // Exclusivity must not cost the toggle: pressing the same pencil twice
    // returns the row to its step list rather than latching it open forever.
    render(
      <TaskEditor
        value={[{ ...emptyTaskDraft(), title: 'Un', scanCost: 10 }]}
        onChange={vi.fn()}
        onRemove={vi.fn()}
        canTick
      />,
    );

    await editTask(0);
    expect(screen.getByDisplayValue('Un')).toBeInTheDocument();

    await editTask(0);
    expect(screen.queryByLabelText('Optional title')).not.toBeInTheDocument();
  });

  it('"+ Add task" closes the form that was open', async () => {
    // Same rule reached the other way: the new task IS a form (it is
    // stepless), so leaving the previous one open would put two on screen.
    const user = userEvent.setup();
    render(
      <ControlledTaskEditor
        initial={[{ ...emptyTaskDraft(), title: 'Un', scanCost: 10 }]}
        onChangeSpy={vi.fn()}
      />,
    );

    await editTask(0);
    expect(screen.getByDisplayValue('Un')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /add task/i }));

    // The new row's form is the only one: Un is back to its step list.
    expect(await screen.findByRole('heading', { name: /^Task 2/ })).toBeInTheDocument();
    expect(screen.getAllByLabelText('Optional title')).toHaveLength(1);
    expect(screen.queryByDisplayValue('Un')).not.toBeInTheDocument();
  });

  it('a second "+ Add task" closes the first unpriced draft, which keeps a pencil to reopen it', async () => {
    // A stepless row auto-opens as a form because there is nothing else to
    // show — but two of them is exactly the wall of forms this rule exists to
    // prevent, so the newest wins. The one left behind must stay reachable:
    // its pencil is normally hidden (a stepless row IS the form), and without
    // it the row would be a dead header line.
    const user = userEvent.setup();
    render(<ControlledTaskEditor initial={[]} onChangeSpy={vi.fn()} />);

    // Name the first draft so the assertions below can tell the two apart —
    // both are stepless, so neither has a price or a step to identify it by.
    await user.click(screen.getByRole('button', { name: /add task/i }));
    await user.type(screen.getByLabelText('Optional title'), 'Un');
    expect(screen.getByDisplayValue('Un')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /add task/i }));

    // Only the new draft's form is open.
    expect(screen.getAllByLabelText('Optional title')).toHaveLength(1);
    expect(screen.queryByDisplayValue('Un')).not.toBeInTheDocument();

    // Un is closed but still openable — its pencil (the only one on screen,
    // since the open stepless row needs none) reopens it and closes the other.
    await editTask(0);
    expect(screen.getAllByLabelText('Optional title')).toHaveLength(1);
    expect(screen.getByDisplayValue('Un')).toBeInTheDocument();
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

  it('removing a row does not disturb the row being edited', async () => {
    // `editingKey` is keyed by `rowKey` (uid-based), not by position, so a
    // removal that shifts every later row down one index must leave the open
    // form exactly where it was. An implementation that tracked the edited row
    // by INDEX would surface here as Deux losing its form — or worse, as the
    // form reappearing on whichever row inherited index 1.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const tasks = [
      { ...emptyTaskDraft(), title: 'Un', scanCost: 10 },
      { ...emptyTaskDraft(), title: 'Deux', scanCost: 20 },
      { ...emptyTaskDraft(), title: 'Trois', scanCost: 30 },
    ];
    render(<RemovableTaskEditor initial={tasks} />);

    await editTask(1);
    expect(screen.getByDisplayValue('Deux')).toBeInTheDocument();

    // Remove Un — the row BEFORE the edited one, so every index shifts.
    const removeButtons = screen.getAllByLabelText('Remove task');
    await act(async () => {
      fireEvent.pointerDown(removeButtons[0]);
      await vi.advanceTimersByTimeAsync(1000);
    });
    vi.useRealTimers();

    expect(screen.queryByRole('heading', { name: /^Un/ })).not.toBeInTheDocument();
    // Deux is still the one mid-edit, despite having slid from index 1 to 0.
    expect(screen.getAllByLabelText('Optional title')).toHaveLength(1);
    expect(screen.getByDisplayValue('Deux')).toBeInTheDocument();
  });

  it('removing the row being edited leaves every survivor read-only', async () => {
    // The stale key must resolve to "nothing open" rather than latching onto
    // whichever row inherits the removed one's slot. Both survivors have
    // steps, so neither is auto-opened by `isEditing`'s stepless fallback —
    // the panel is simply left with no form, which is the honest answer.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const tasks = [
      { ...emptyTaskDraft(), title: 'Un', scanCost: 10 },
      { ...emptyTaskDraft(), title: 'Deux', scanCost: 20 },
    ];
    render(<RemovableTaskEditor initial={tasks} />);

    await editTask(0);
    expect(screen.getByDisplayValue('Un')).toBeInTheDocument();

    const removeButtons = screen.getAllByLabelText('Remove task');
    await act(async () => {
      fireEvent.pointerDown(removeButtons[0]);
      await vi.advanceTimersByTimeAsync(1000);
    });
    vi.useRealTimers();

    expect(screen.getByRole('heading', { name: /^Deux/ })).toBeInTheDocument();
    expect(screen.queryByLabelText('Optional title')).not.toBeInTheDocument();
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
    // instead. The quantity-discount curve (utils/pricing.ts) shaves the
    // margin above cost as quantity rises, so quantity 2's total sits
    // strictly between the quantity-1 total (what the buggy per-unit report
    // would still show, since it barely moves with quantity) and its naive
    // double (what the old flat markup would have produced exactly).
    const onChangeSpy = vi.fn();
    const user = userEvent.setup();
    render(<ControlledTaskEditor initial={[emptyTaskDraft()]} onChangeSpy={onChangeSpy} />);
    // A stepless task IS the form already — no expand/edit click needed, but
    // Printing is still a chip on an empty draft: enable it to reveal
    // ImpressionFields.
    await user.click(screen.getByRole('button', { name: 'Add Printing' }));

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
    // Qualified accessible name, not the bare visible "Quantity" label — see
    // QuantityInput's doc.
    const quantityInput = screen.getByLabelText('Printing Quantity');
    fireEvent.change(quantityInput, { target: { value: '2' } });

    await waitFor(() => {
      const lastTasks = onChangeSpy.mock.calls.at(-1)?.[0] as TaskDraft[] | undefined;
      expect(lastTasks?.[0].impressionCost).not.toBeNull();
      expect(lastTasks?.[0].impressionCost).toBeGreaterThan(quantityOneCost);
      expect(lastTasks?.[0].impressionCost).toBeLessThan(quantityOneCost * 2);
    });
  });

  it('printing: clamps a negative typed weight to zero, and reprices the clamped value rather than the negative one', async () => {
    // ImpressionFields' weight handler is `Math.max(0, Number(e.target.value))`
    // — every existing test types only well-formed positive weights, so this
    // is the only test that would notice the clamp being dropped (which would
    // let a negative weight reach `computeImpressionCost` and corrupt the
    // printed total).
    const onChangeSpy = vi.fn();
    const task: TaskDraft = {
      ...emptyTaskDraft(),
      impression: { printerId: 1, filamentId: 1, weightG: 40, timeMin: 60, quantity: 1, color: 'Noir' },
      impressionCost: 500,
    };
    render(<ControlledTaskRow initial={task} onChangeSpy={onChangeSpy} />);

    const weightInput = await screen.findByLabelText(/weight/i);
    // Wait for the reference-data queries to resolve first: firing the edit
    // while they are still pending hits ImpressionFields' `referenceDataLoading`
    // guard, which reports the edit with no computed cost at all — leaving
    // `impressionCost` unchanged and making the assertion below meaningless.
    await waitFor(() => expect(screen.getByTestId('impression-computed')).not.toHaveTextContent('—'));
    fireEvent.change(weightInput, { target: { value: '-10' } });

    // Positive evidence first: the field itself settles on the clamped value
    // (the parent state ImpressionFields is controlled by), not the typed
    // negative one.
    await waitFor(() => expect(weightInput).toHaveValue(0));

    const lastTask = onChangeSpy.mock.calls.at(-1)?.[0] as TaskDraft;
    expect(lastTask.impression?.weightG).toBe(0);

    // The clamp feeds the priced total too: the reported cost is what a 0 g
    // print prices to, not whatever a raw -10 g would have produced.
    const pricedAtZero = computeImpressionCost(
      { ...task.impression, weightG: 0 },
      mockFilaments[0],
      mockPrinters[0],
      mockDefaults,
    );
    expect(lastTask.impressionCost).toBe(roundUpTo50(pricedAtZero!.total_ttc));
  });

  it('printing: clamps a zero-typed or fractional quantity to a positive integer, and reprices at the clamped value', async () => {
    // ImpressionFields' quantity handler is
    // `Math.max(1, Math.floor(Number(e.target.value) || 1))` — every existing
    // test types only well-formed positive integers, so this is the only test
    // that would notice either the `|| 1` fallback (for a typed '0', where
    // `Number('0')` is falsy) or the `Math.floor` (for a typed '1.5') being
    // dropped, both of which would let a bad piece count reach the printed
    // total.
    const onChangeSpy = vi.fn();
    const task: TaskDraft = {
      ...emptyTaskDraft(),
      impression: { printerId: 1, filamentId: 1, weightG: 40, timeMin: 60, quantity: 2, color: 'Noir' },
      impressionCost: 500,
    };
    render(<ControlledTaskRow initial={task} onChangeSpy={onChangeSpy} />);

    // Qualified accessible name, not the bare visible "Quantity" label — see
    // QuantityInput's doc.
    const quantityInput = await screen.findByLabelText('Printing Quantity');
    // Wait for the reference-data queries to resolve first: firing the edit
    // while they are still pending hits ImpressionFields' `referenceDataLoading`
    // guard, which reports the edit with no computed cost at all — leaving
    // `impressionCost` unchanged and making the assertions below meaningless.
    await waitFor(() => expect(screen.getByTestId('impression-computed')).not.toHaveTextContent('—'));
    const pricedOne = computeImpressionCost(
      { ...task.impression, quantity: 1 },
      mockFilaments[0],
      mockPrinters[0],
      mockDefaults,
    );
    const expectedCostAtOne = roundUpTo50(pricedOne!.total_ttc);

    // A typed '0': `Number('0')` is falsy, so without the `|| 1` fallback the
    // stored quantity would be zero pieces.
    fireEvent.change(quantityInput, { target: { value: '0' } });
    await waitFor(() => expect(quantityInput).toHaveValue(1));
    let lastTask = onChangeSpy.mock.calls.at(-1)?.[0] as TaskDraft;
    expect(lastTask.impression?.quantity).toBe(1);
    expect(lastTask.impressionCost).toBe(expectedCostAtOne);

    onChangeSpy.mockClear();

    // A typed '1.5': without `Math.floor`, the stored quantity would be a
    // fractional piece count.
    fireEvent.change(quantityInput, { target: { value: '1.5' } });
    await waitFor(() => expect(quantityInput).toHaveValue(1));
    lastTask = onChangeSpy.mock.calls.at(-1)?.[0] as TaskDraft;
    expect(lastTask.impression?.quantity).toBe(1);
    expect(lastTask.impressionCost).toBe(expectedCostAtOne);
  });

  it('printing: every print parameter is on screen, with no disclosure to open', async () => {
    const task = {
      ...emptyTaskDraft(),
      impression: { printerId: 1, filamentId: 1, weightG: 40, timeMin: 60, quantity: 1, color: 'Noir' },
      impressionCost: 500,
    };
    render(<ControlledTaskRow initial={task} onChangeSpy={vi.fn()} />);

    // The toggle is gone entirely: roughly half of printing tasks are priced
    // by the calculator and half by hand, so neither path may sit behind a
    // disclosure. C4 absorbs the three parameters into rows the block needs
    // anyway, so they cost no height.
    expect(screen.queryByRole('button', { name: 'Calculator' })).not.toBeInTheDocument();
    await screen.findByRole('combobox', { name: /printer/i });
    screen.getByLabelText(/weight/i);
    // The duration segments name only their own unit (see DurationInput).
    screen.getByRole('spinbutton', { name: 'Hours' });

    // One grid holds both halves: the part's identity and its price.
    const grid = within(screen.getByTestId('impression-grid'));
    grid.getByLabelText(/printing cost/i);
    // Qualified accessible names, not the bare visible labels — see
    // QuantityInput's/DiscountSelect's docs.
    grid.getByLabelText('Printing Quantity');
    grid.getByLabelText('Printing Discount');
    grid.getByRole('combobox', { name: /material/i });
    grid.getByLabelText('Colour');
  });

  it('printing: the band shows the line total and the cost split when a price can be computed', async () => {
    const task = {
      ...emptyTaskDraft(),
      impression: { printerId: 1, filamentId: 1, weightG: 40, timeMin: 60, quantity: 2, color: 'Noir' },
      impressionCost: 1000,
    };
    render(<ControlledTaskRow initial={task} onChangeSpy={vi.fn()} />);

    const band = within(await screen.findByTestId('impression-band'));
    // The band renders as soon as there is a line total, before printers/
    // filaments/defaults resolve — its testid appears immediately, carrying
    // the total and (since the loading-state fix above) no "not configured"
    // message. Wait for the cost split itself (async, so it retries) rather
    // than for the testid, or the assertions below race the fetch.
    await band.findByRole('img', { name: 'Where the money goes' });
    // The charged figure, not the computed one: unit × quantity, less any
    // discount. This is what the quote line will say. The test harness's
    // settings mock (and useCurrency's fallback) both resolve to USD.
    // getByText's default normalizer collapses all whitespace (including the
    // thin space formatMoney uses as a thousands separator) to a single
    // ASCII space before matching — do the same to the expected string, or
    // an exact-looking match still misses (see the taskTotal test above).
    band.getByText(formatMoney(1000, 'USD').replace(/\s+/g, ' '));
    // The exact seven figures stay one disclosure away.
    band.getByText('Cost detail');
  });

  it('printing: does not show the false "not configured" message while printers/filaments are still loading', async () => {
    // Both queries are held open deliberately, then resolved by hand, so the
    // assertions below land inside the loading window on purpose. Before this
    // fix, `notConfigured` read straight off `printers`/`filaments`' `?? []`
    // fallback — indistinguishable from a genuinely empty calculator until the
    // fetch actually resolves — so every printing task asserted "No printers
    // configured" plus a `/calculator` link for the whole cold-cache window.
    let resolveFilaments: (v: unknown) => void = () => {};
    let resolvePrinters: (v: unknown) => void = () => {};
    const filamentsPromise = new Promise((resolve) => {
      resolveFilaments = resolve;
    });
    const printersPromise = new Promise((resolve) => {
      resolvePrinters = resolve;
    });
    server.use(
      http.get('/api/v1/calculator/filaments/', async () => {
        await filamentsPromise;
        return HttpResponse.json(mockFilaments);
      }),
      http.get('/api/v1/calculator/printers/', async () => {
        await printersPromise;
        return HttpResponse.json(mockPrinters);
      }),
    );

    const task = {
      ...emptyTaskDraft(),
      impression: { printerId: 1, filamentId: 1, weightG: 40, timeMin: 60, quantity: 1, color: 'Noir' },
      impressionCost: 500,
    };
    render(<ControlledTaskRow initial={task} onChangeSpy={vi.fn()} />);

    const band = within(await screen.findByTestId('impression-band'));
    // Give the still-pending queries (and any render they would trigger) a
    // real chance to settle before asserting on the loading-window content —
    // if the guard regresses, this is where the false message would show up.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(band.queryByText(/no printers configured/i)).not.toBeInTheDocument();
    expect(band.queryByText(/no filaments configured/i)).not.toBeInTheDocument();
    expect(band.queryByRole('link', { name: 'Calculator' })).not.toBeInTheDocument();

    resolveFilaments(undefined);
    resolvePrinters(undefined);

    // Once the queries land, the band settles into the real cost split — the
    // same end state as the "shows the line total and the cost split" test.
    await band.findByRole('img', { name: 'Where the money goes' });
  });

  it('printing: reports a failed reference-data fetch as pricing unavailable, not as unconfigured', async () => {
    // `isLoading` (`isPending && isFetching`) goes FALSE the instant a query
    // settles into its error state, and `printers`/`filaments` still default
    // to `[]` on error — so an ungated check reads a fetch failure exactly
    // like a genuinely empty calculator and sends the operator to
    // `/calculator` to "fix" a configuration problem that does not exist.
    server.use(http.get('/api/v1/calculator/printers/', () => HttpResponse.error()));

    const task = {
      ...emptyTaskDraft(),
      impression: { printerId: 1, filamentId: 1, weightG: 40, timeMin: 60, quantity: 1, color: 'Noir' },
      impressionCost: 500,
    };
    render(<ControlledTaskRow initial={task} onChangeSpy={vi.fn()} />);

    const band = within(await screen.findByTestId('impression-band'));
    await band.findByText('Could not load calculator pricing. Please try again.');
    expect(band.queryByText(/no printers configured/i)).not.toBeInTheDocument();
    expect(band.queryByText(/no filaments configured/i)).not.toBeInTheDocument();
    // No trip to the calculator either: there is nothing misconfigured there.
    expect(band.queryByRole('link', { name: 'Calculator' })).not.toBeInTheDocument();
  });

  it('printing: keeps the computed price when a background refetch fails after data has already loaded', async () => {
    // With `staleTime: 60_000` and v5's default `refetchOnWindowFocus`, a
    // reference-data query can fail on a REFETCH while the previously-fetched
    // list is still sitting in its cache — `isError` goes true, but `data`
    // (and everything `ImpressionFields` prices with) is untouched. That is a
    // different, later state than the cold-cache failure above, and must not
    // collapse into the same "pricing unavailable" message: the band still
    // has everything it needs to show a real price.
    const task = {
      ...emptyTaskDraft(),
      impression: { printerId: 1, filamentId: 1, weightG: 40, timeMin: 60, quantity: 1, color: 'Noir' },
      impressionCost: 500,
    };
    const client = renderControlledTaskRowWithClient(task, vi.fn());

    // Let all three reference-data queries land successfully first — same
    // settled state as the "shows the line total and the cost split" test.
    const band = within(await screen.findByTestId('impression-band'));
    await band.findByRole('img', { name: 'Where the money goes' });

    // Fail the next fetch and force a refetch directly on the client. This
    // reaches the real-world "background refetch failed" state (`isError`
    // true, cached `data` retained) without depending on `staleTime` or
    // window-focus timing, which jsdom does not model deterministically.
    server.use(http.get('/api/v1/calculator/printers/', () => HttpResponse.error()));
    await act(async () => {
      await client.refetchQueries({ queryKey: ['calculatorPrinters'] });
    });

    // Positive evidence FIRST: without this, the two assertions below can run
    // before the failed-refetch state has actually propagated through
    // `printersQuery` and into `referenceDataError`, and the negative
    // assertion passes vacuously — it would pass whether or not the fix
    // exists. Only once the query has genuinely settled into `error` (with
    // `data` retained, since `retry: false` and the mocked response reject
    // immediately) does checking for the absent error message actually prove
    // anything.
    await waitFor(() => {
      expect(client.getQueryState(['calculatorPrinters'])?.status).toBe('error');
    });

    expect(band.queryByText('Could not load calculator pricing. Please try again.')).not.toBeInTheDocument();
    band.getByRole('img', { name: 'Where the money goes' });
  });

  it('printing: still reports "No printers configured" when the calculator genuinely has none', async () => {
    server.use(http.get('/api/v1/calculator/printers/', () => HttpResponse.json([])));

    const task = {
      ...emptyTaskDraft(),
      impression: { printerId: null, filamentId: 1, weightG: 40, timeMin: 60, quantity: 1, color: 'Noir' },
      impressionCost: 500,
    };
    render(<ControlledTaskRow initial={task} onChangeSpy={vi.fn()} />);

    const band = within(await screen.findByTestId('impression-band'));
    await band.findByText(/no printers configured/i);
    band.getByRole('link', { name: 'Calculator' });
    expect(band.queryByText('Could not load calculator pricing. Please try again.')).not.toBeInTheDocument();
  });

  it('printing: still reports "No filaments configured" when the calculator genuinely has none', async () => {
    server.use(http.get('/api/v1/calculator/filaments/', () => HttpResponse.json([])));

    const task = {
      ...emptyTaskDraft(),
      impression: { printerId: 1, filamentId: null, weightG: 40, timeMin: 60, quantity: 1, color: 'Noir' },
      impressionCost: 500,
    };
    render(<ControlledTaskRow initial={task} onChangeSpy={vi.fn()} />);

    const band = within(await screen.findByTestId('impression-band'));
    await band.findByText(/no filaments configured/i);
    band.getByRole('link', { name: 'Calculator' });
    expect(band.queryByText('Could not load calculator pricing. Please try again.')).not.toBeInTheDocument();
  });

  it('printing: the band still carries the total when nothing can be computed', async () => {
    // A hand-typed cost and no printer — an imported quote looks exactly like
    // this. The old layout left half the block empty here. Quantity is 3 (not
    // the emptyTaskDraft default of 1) so the total (9000) and the per-part
    // rate (now stated unconditionally — see Task 11 — as 9000/3 = 3000) are
    // distinct figures: getByText keeps its original meaning of "exactly one
    // $9,000.00 node", rather than being weakened to "at least one".
    const task = {
      ...emptyTaskDraft(),
      impression: { ...emptyTaskDraft().impression, quantity: 3 },
      impressionCost: 9000,
    };
    render(<ControlledTaskRow initial={task} onChangeSpy={vi.fn()} />);

    const band = within(await screen.findByTestId('impression-band'));
    band.getByText(formatMoney(9000, 'USD').replace(/\s+/g, ' '));
    expect(band.queryByRole('img', { name: 'Where the money goes' })).not.toBeInTheDocument();
    // No split, and no instructions in its place either: the band states what
    // it knows and stays quiet about what it doesn't. The operator filling
    // the form in does not need to be told to fill the form in.
    expect(band.queryByText(/fill in printer/i)).not.toBeInTheDocument();
  });

  it('printing: no apply button while the stored price already is the computed one', async () => {
    const task = {
      ...emptyTaskDraft(),
      impression: { printerId: 1, filamentId: 1, weightG: 40, timeMin: 60, quantity: 1, color: 'Noir' },
      impressionCost: null,
    };
    render(<ControlledTaskRow initial={task} onChangeSpy={vi.fn()} />);

    // impressionCost is null, so the Printing chip starts off (see
    // TaskStepFields: chips are seeded from costKey !== null, not from
    // whether `impression` itself is populated) — enable it to reach the
    // weight field, same as the other tests here that start from an unpriced
    // draft.
    fireEvent.click(screen.getByRole('button', { name: 'Add Printing' }));

    // The weight field renders immediately, before the filaments/printers/
    // defaults queries resolve — firing the edit before they land would hit
    // ImpressionFields' `referenceDataLoading` guard, which reports the edit
    // with no computed cost at all (`computedCost` stays `undefined`),
    // leaving the stored cost null forever and making Apply appear for the
    // wrong reason. Wait for the row to leave its not-yet-computable state
    // first.
    await waitFor(() => expect(screen.getByTestId('impression-computed')).not.toHaveTextContent('—'));

    // Typing a weight reprices as it always has, so stored and computed agree
    // and there is nothing to offer. The value must actually differ from the
    // field's current 40 — `fireEvent.change` to an identical value does not
    // trigger React's onChange at all, which would leave the stored cost null
    // and make Apply appear for the same wrong reason as above.
    fireEvent.change(await screen.findByLabelText(/weight/i), { target: { value: '45' } });
    await waitFor(() => expect(screen.getByTestId('impression-computed')).not.toHaveTextContent('—'));
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
  });

  it('printing: a hand-typed price offers the computed one, and applying it stores unit × quantity', async () => {
    const onChange = vi.fn();
    const task = {
      ...emptyTaskDraft(),
      impression: { printerId: 1, filamentId: 1, weightG: 40, timeMin: 60, quantity: 2, color: 'Noir' },
      impressionCost: 40_000,
    };
    render(<ControlledTaskRow initial={task} onChangeSpy={onChange} />);

    // 20 000 apiece by hand is not what the calculator makes of 40 g on the
    // H2S, so the alternative becomes offerable — this is the case the old UI
    // silently lost.
    const apply = await screen.findByRole('button', { name: 'Apply' });
    fireEvent.click(apply);

    const next = onChange.mock.calls.at(-1)?.[0];
    // The computed UNIT price is rounded up to the shop's 50-multiple tier,
    // then multiplied — the stored total is always an exact multiple of the
    // advertised per-piece price. Derived here with the same helpers the
    // component uses: this test is about the wiring, and roundUpTo50 and
    // computeImpressionCost each have their own tests in taskDraft.test.ts.
    const priced = computeImpressionCost(task.impression, mockFilaments[0], mockPrinters[0], mockDefaults);
    expect(next.impressionCost).toBe(roundUpTo50(priced!.total_ttc) * 2);
    expect(next.impressionCost).not.toBe(40_000);
  });

  it('printing: the calculator-price row falls back to a dash when no price can be computed', async () => {
    render(<ControlledTaskRow initial={{ ...emptyTaskDraft(), impressionCost: 9000 }} onChangeSpy={vi.fn()} />);

    // The row keeps its label ("Calculator price", which is what names the
    // figure) and shows a dash where the amount would be — no "Not
    // computable" verdict for the operator to interpret.
    expect(await screen.findByTestId('impression-computed')).toHaveTextContent('—');
    expect(screen.getByText('Calculator price')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
  });

  it('printing: the note is one click away, and already open when the task has one', async () => {
    const { unmount } = render(
      <ControlledTaskRow initial={{ ...emptyTaskDraft(), impressionCost: 500 }} onChangeSpy={vi.fn()} />,
    );

    const textarea = /printing.*optional description/i;
    expect(screen.queryByLabelText(textarea)).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Note for the quote' }));
    expect(await screen.findByLabelText(textarea)).toBeInTheDocument();

    // A task that already carries a description opens with it visible — it
    // must never hide text the operator already wrote. Unmount and mount a
    // fresh row rather than `rerender()`: a real caller mounts one row per
    // task and never swaps one task's props onto another row's live
    // component instance, so a fresh mount is what actually exercises the
    // "already open" seeding — reusing the instance above would exercise
    // ControlledTaskRow's own prop-sync behaviour instead, which does not
    // exist and is not the point of this test.
    unmount();
    render(
      <ControlledTaskRow
        initial={{ ...emptyTaskDraft(), impressionCost: 500, impressionDescription: 'Bord poli' }}
        onChangeSpy={vi.fn()}
      />,
    );
    expect(await screen.findByDisplayValue('Bord poli')).toBeInTheDocument();
  });
});

describe('TaskEditor accordion (create drawer)', () => {
  const priced = (title: string): TaskDraft => ({ ...emptyTaskDraft(), title, scanCost: 10 });

  function renderAccordion(tasks: TaskDraft[]) {
    render(<TaskEditor value={tasks} onChange={vi.fn()} onRemove={vi.fn()} canTick={false} accordion />);
  }

  // The collapsed body stays MOUNTED so the fold can animate height both ways
  // (a grid row interpolating 1fr↔0fr, same idiom as the drawer's Section);
  // `inert` is what keeps the closed state honest — height 0 hides the body
  // but alone would leave it in Tab order. So "folded" is asserted as
  // inert-ancestry, not absence from the document.
  const folded = (el: HTMLElement) => el.closest('[inert]') !== null;

  it('opens the first task and collapses the rest', () => {
    renderAccordion([priced('Alpha'), priced('Beta')]);
    expect(screen.getByRole('button', { name: /Alpha/, expanded: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Beta/, expanded: false })).toBeInTheDocument();
    // The collapsed row's body — its progress included — is folded away inert.
    expect(folded(screen.getByTestId('task-progress-0'))).toBe(false);
    expect(folded(screen.getByTestId('task-progress-1'))).toBe(true);
  });

  it('clicking a collapsed header opens it and collapses the previously open task', async () => {
    renderAccordion([priced('Alpha'), priced('Beta')]);
    await userEvent.click(screen.getByRole('button', { name: /Beta/, expanded: false }));
    expect(screen.getByRole('button', { name: /Beta/, expanded: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Alpha/, expanded: false })).toBeInTheDocument();
    expect(folded(screen.getByTestId('task-progress-0'))).toBe(true);
    expect(folded(screen.getByTestId('task-progress-1'))).toBe(false);
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
    // Alpha (index 0) collapsed: its progress is folded away inert.
    expect(screen.getByRole('button', { name: /Alpha/, expanded: false })).toBeInTheDocument();
    expect(folded(screen.getByTestId('task-progress-0'))).toBe(true);
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
    // Which row ends up EXPANDED is settled by `effectiveOpenKey` alone,
    // derived from `openKey` and `value` and never from `editingKey` — the
    // two dangling-key fallbacks are deliberately independent, so a change to
    // how edit state survives a removal must not move this answer.
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

const twoTasks = () => {
  const a = { ...emptyTaskDraft(), title: 'Alpha', scanCost: 100 };
  const b = { ...emptyTaskDraft(), title: 'Beta', scanCost: 200 };
  return [a, b];
};

describe('task reordering', () => {
  it('reorderedTasks moves the active row into the over row slot', () => {
    const [a, b] = twoTasks();
    const next = reorderedTasks([a, b], rowKey(a), rowKey(b));
    expect(next?.map((task) => task.title)).toEqual(['Beta', 'Alpha']);
  });

  it('reorderedTasks returns null for a drop on itself or an unknown id', () => {
    const [a, b] = twoTasks();
    expect(reorderedTasks([a, b], rowKey(a), rowKey(a))).toBeNull();
    expect(reorderedTasks([a, b], 'nope', rowKey(b))).toBeNull();
  });

  it('shows a grab handle per row when onReorder is provided and there are 2+ rows', () => {
    render(
      <TaskEditor value={twoTasks()} onChange={vi.fn()} onRemove={vi.fn()} canTick={false} onReorder={vi.fn()} />,
    );
    expect(screen.getAllByRole('button', { name: 'Reorder task' })).toHaveLength(2);
  });

  it('shows no handles without onReorder', () => {
    render(<TaskEditor value={twoTasks()} onChange={vi.fn()} onRemove={vi.fn()} canTick={false} />);
    expect(screen.queryByRole('button', { name: 'Reorder task' })).toBeNull();
  });

  it('shows no handles with a single row', () => {
    render(
      <TaskEditor value={[twoTasks()[0]]} onChange={vi.fn()} onRemove={vi.fn()} canTick={false} onReorder={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'Reorder task' })).toBeNull();
  });

  it('shows no handles while any row has a create POST in flight', () => {
    const [a, b] = twoTasks();
    render(
      <TaskEditor
        value={[a, b]}
        onChange={vi.fn()}
        onRemove={vi.fn()}
        canTick={false}
        onReorder={vi.fn()}
        pendingUids={new Set([a.uid])}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Reorder task' })).toBeNull();
  });

  describe('handleDragEnd wiring', () => {
    beforeEach(() => {
      mockCapturedOnDragEnd.current = undefined;
    });

    it('a completed drop calls onReorder with the moved array', () => {
      const [a, b] = twoTasks();
      const onReorder = vi.fn();
      render(<TaskEditor value={[a, b]} onChange={vi.fn()} onRemove={vi.fn()} canTick={false} onReorder={onReorder} />);

      expect(mockCapturedOnDragEnd.current).toBeTypeOf('function');
      act(() => {
        mockCapturedOnDragEnd.current!({ active: { id: rowKey(a) }, over: { id: rowKey(b) } });
      });

      expect(onReorder).toHaveBeenCalledTimes(1);
      expect(onReorder.mock.calls[0][0].map((task: TaskDraft) => task.title)).toEqual(['Beta', 'Alpha']);
    });

    it('a drop with no target (over null) does not call onReorder', () => {
      const [a, b] = twoTasks();
      const onReorder = vi.fn();
      render(<TaskEditor value={[a, b]} onChange={vi.fn()} onRemove={vi.fn()} canTick={false} onReorder={onReorder} />);

      act(() => {
        mockCapturedOnDragEnd.current!({ active: { id: rowKey(a) }, over: null });
      });

      expect(onReorder).not.toHaveBeenCalled();
    });

    it('a drop on itself does not call onReorder', () => {
      const [a, b] = twoTasks();
      const onReorder = vi.fn();
      render(<TaskEditor value={[a, b]} onChange={vi.fn()} onRemove={vi.fn()} canTick={false} onReorder={onReorder} />);

      act(() => {
        mockCapturedOnDragEnd.current!({ active: { id: rowKey(a) }, over: { id: rowKey(a) } });
      });

      expect(onReorder).not.toHaveBeenCalled();
    });
  });
});
