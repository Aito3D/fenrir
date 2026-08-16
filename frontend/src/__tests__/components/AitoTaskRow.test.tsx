/**
 * Task 17: task rows stop collapsing. A row is always open — read mode
 * (`TaskStepList`) for a task with steps, the raw form (`TaskStepFields`) for
 * one without, since a stepless row has nothing else to show. There is no
 * disclosure control left to test.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { TaskRow } from '../../components/aito/TaskRow';
import { taskSteps } from '../../components/aito/services';
import { emptyTaskDraft } from '../../utils/taskDraft';
import type { TaskDraft } from '../../utils/taskDraft';

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

server.use(
  http.get('/api/v1/calculator/filaments/', () => HttpResponse.json(mockFilaments)),
  http.get('/api/v1/calculator/printers/', () => HttpResponse.json(mockPrinters)),
  http.get('/api/v1/calculator/defaults', () => HttpResponse.json(mockDefaults)),
);

function makeTask(overrides: Partial<TaskDraft> = {}): TaskDraft {
  return { ...emptyTaskDraft(), title: 'Bracket', ...overrides };
}

/** Renders a single `TaskRow` with sane defaults for the props this file
 *  doesn't care about. `editing` mirrors what `TaskEditor` actually derives
 *  (see its `isEditing`) rather than a bare `false`: a stepless task is
 *  always the caller's edit form, in production as much as in this
 *  file — `TaskRow` itself has no opinion, it only renders what it is told. */
function renderRow(
  task: TaskDraft,
  { canTick, editing = taskSteps(task).length === 0 }: { canTick: boolean; editing?: boolean },
) {
  return render(
    <TaskRow
      task={task}
      index={0}
      onChange={vi.fn()}
      onRemove={vi.fn()}
      editing={editing}
      onToggleEdit={vi.fn()}
      canTick={canTick}
    />,
  );
}

describe('TaskRow', () => {
  it('shows a task step without anything needing to be opened first', () => {
    renderRow(makeTask({ scanCost: 20, done: { scan: false, modelisation: false, impression: false, usinage: false } }), {
      canTick: true,
    });
    // Straight to the Done toggle — no disclosure click in between.
    expect(screen.getByRole('button', { name: /Scan/i })).toBeInTheDocument();
  });

  it('has no disclosure control at all', () => {
    renderRow(makeTask({ scanCost: 20 }), { canTick: true });
    expect(screen.queryByRole('button', { expanded: false })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { expanded: true })).not.toBeInTheDocument();
  });

  it('shows the form, not "no steps yet", on a task with nothing priced', () => {
    // A row with no steps IS the form — there is nothing else it could show.
    renderRow(makeTask({}), { canTick: false });
    expect(screen.queryByText(/no steps yet/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/scan/i)).toBeInTheDocument();
  });

  it('hides the edit toggle on a stepless row', () => {
    // There is no other mode to switch to, so an inert toggle explains nothing.
    renderRow(makeTask({}), { canTick: false });
    expect(screen.queryByRole('button', { name: /edit task/i })).not.toBeInTheDocument();
  });

  it('shows the edit toggle once the row has at least one step', () => {
    renderRow(makeTask({ scanCost: 20 }), { canTick: true });
    expect(screen.getByRole('button', { name: /edit task/i })).toBeInTheDocument();
  });

  it('drops the collapsed-only service badges from the header — the step list below already names every service', () => {
    renderRow(makeTask({ scanCost: 20, usinageCost: 5 }), { canTick: true });
    // "Scan" and "Machining" still appear (in the step list), but not as a
    // second, redundant copy in the header — there is exactly one of each.
    expect(screen.getAllByText('Scan')).toHaveLength(1);
    expect(screen.getAllByText('Machining')).toHaveLength(1);
  });

  it('shows how far through its own steps the task is', () => {
    renderRow(
      makeTask({
        scanCost: 3500,
        modelisationCost: 4500,
        impressionCost: 10000,
        done: { scan: true, modelisation: false, impression: false, usinage: false },
      }),
      { canTick: true },
    );
    expect(screen.getByText('1/3 steps')).toBeInTheDocument();
    expect(screen.getByTestId('task-progress-0')).toHaveStyle({ width: '33%' });
  });

  it('re-enters the body with the rise animation on the read↔edit swap', () => {
    // The two bodies differ wildly in height, so the swap gets a soft entrance
    // (`animate-rise-sm` on a container keyed by mode) rather than a height
    // morph. Both branches must sit inside that container, or only one
    // direction of the swap would animate.
    renderRow(makeTask({ scanCost: 20 }), { canTick: true });
    expect(screen.getByRole('button', { name: /Scan/i }).closest('.animate-rise-sm')).not.toBeNull();
    renderRow(makeTask({ scanCost: 20 }), { canTick: true, editing: true });
    expect(screen.getAllByLabelText(/scan/i)[0].closest('.animate-rise-sm')).not.toBeNull();
  });

  it('renders no progress for a task with no priced steps', () => {
    renderRow(makeTask({}), { canTick: false });
    expect(screen.queryByTestId('task-progress-0')).not.toBeInTheDocument();
  });

  it('gives a finished card a background mixed from the surface tier, not the canvas', () => {
    // Task 10 put the task column on `bg-bambu-dark` canvas. A flat
    // `bg-bambu-green/5` wash — 5%-alpha green with nothing under it — blends
    // over that near-black canvas to something DARKER than an unfinished
    // sibling's plain `bg-bambu-dark-secondary`, so a completed task read as
    // recessed rather than complete: the exact hierarchy inversion Task 10
    // exists to prevent. The fix mixes the accent over the surface-tier
    // variable instead, so this pins the mix target rather than merely the
    // presence of some green class.
    const { container } = renderRow(
      makeTask({ scanCost: 20, done: { scan: true, modelisation: false, impression: false, usinage: false } }),
      { canTick: true },
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain(
      'color-mix(in_srgb,var(--color-bambu-green)_5%,var(--color-bambu-dark-secondary))',
    );
    expect(card.className).not.toContain('bg-bambu-green/5');
  });

  it('rounds the card to .6rem, matching the panel\'s reference cards', () => {
    // Visual-parity fix: the card used to be rounded-lg (.5rem / 7.2px at this
    // app's 14.4px root); the approved reference measures .6rem (8.64px).
    const { container } = renderRow(makeTask({ scanCost: 20 }), { canTick: true });
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain('rounded-[.6rem]');
  });

  it('keeps the remove control hover-revealed here — only the panel footer\'s copy of it goes permanent', () => {
    // DeleteHoldButton grew an opt-in `alwaysVisible` prop for the panel
    // footer (visual-parity fix); TaskRow must keep passing nothing, so its
    // own remove control stays the group-hover reveal it always was.
    renderRow(makeTask({ scanCost: 20 }), { canTick: true });
    const removeButton = screen.getByRole('button', { name: /remove task/i });
    expect(removeButton.className).toContain('opacity-0');
    expect(removeButton.className).toContain('group-hover:opacity-100');
    expect(removeButton).not.toHaveTextContent('Remove task');
  });
});

describe('task description', () => {
  // The task-level description paragraph is gone — each step now carries its
  // own text (Task 7), rendered by `TaskStepList` under its row. These tests
  // exercise that through `TaskRow` (read mode mounts `TaskStepList`), the
  // same way the panel actually renders it.
  function renderRow(overrides: Partial<TaskDraft> = {}, { editing = false }: { editing?: boolean } = {}) {
    return render(
      <TaskRow
        task={makeTask(overrides)}
        index={0}
        onChange={vi.fn()}
        onRemove={vi.fn()}
        editing={editing}
        onToggleEdit={vi.fn()}
        canTick={true}
      />,
    );
  }

  it('shows each step description under its step row in read mode', () => {
    renderRow({ scanCost: 100, scanDescription: 'Scanner la pièce' });
    expect(screen.getByText('Scanner la pièce')).toBeInTheDocument();
  });

  it('renders no description element for a step without one', () => {
    renderRow({ scanCost: 100, scanDescription: '' });
    expect(screen.queryByTestId('step-desc-scan')).toBeNull();
  });

  it('hides step descriptions in edit mode — the form already carries the field', () => {
    renderRow({ scanCost: 100, scanDescription: 'Scanner la pièce' }, { editing: true });
    expect(screen.queryByTestId('step-desc-scan')).toBeNull();
  });
});
