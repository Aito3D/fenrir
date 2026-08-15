import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { TaskStepList } from '../../components/aito/TaskStepList';
import { emptyTaskDraft } from '../../utils/taskDraft';
import type { ImpressionDraft, TaskDraft } from '../../utils/taskDraft';

const task = (overrides: Partial<TaskDraft> = {}): TaskDraft => ({
  ...emptyTaskDraft(),
  title: 'Bracket',
  scanCost: 1200,
  impressionCost: 2400,
  ...overrides,
});

describe('TaskStepList', () => {
  it('lists only the steps that exist', () => {
    render(<TaskStepList task={task()} onChange={vi.fn()} canTick />);
    expect(screen.getByText('Scan')).toBeInTheDocument();
    expect(screen.getByText('Printing')).toBeInTheDocument();
    expect(screen.queryByText('Modeling')).not.toBeInTheDocument();
    expect(screen.queryByText('Machining')).not.toBeInTheDocument();
  });

  it('shows a step quoted at zero, because free is not absent', () => {
    render(<TaskStepList task={task({ modelisationCost: 0 })} onChange={vi.fn()} canTick />);
    expect(screen.getByText('Modeling')).toBeInTheDocument();
  });

  it('reports a tick upward without mutating the task', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const original = task();
    render(<TaskStepList task={original} onChange={onChange} canTick />);

    await user.click(screen.getByRole('button', { name: /Scan/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].done.scan).toBe(true);
    expect(original.done.scan).toBe(false);
  });

  it('un-ticks in one click — undo must be cheap', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const ticked = task({ done: { scan: true, modelisation: false, impression: false, usinage: false } });
    render(<TaskStepList task={ticked} onChange={onChange} canTick />);

    expect(screen.getByRole('button', { name: /Scan/i })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: /Scan/i }));
    expect(onChange.mock.calls[0][0].done.scan).toBe(false);
  });

  it('says so when a task has no steps yet', () => {
    render(<TaskStepList task={emptyTaskDraft()} onChange={vi.fn()} canTick />);
    expect(screen.getByText(/no steps yet/i)).toBeInTheDocument();
  });

  it('offers no Done toggle when the quote is not accepted', () => {
    render(<TaskStepList task={task()} onChange={vi.fn()} canTick={false} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('Scan')).toBeInTheDocument();
  });

  it('still shows a ticked step as history when the quote is not accepted', () => {
    const ticked = task({ done: { scan: true, modelisation: false, impression: false, usinage: false } });
    render(<TaskStepList task={ticked} onChange={vi.fn()} canTick={false} />);
    expect(screen.getByText('Scan')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('makes the whole row the toggle, not just a pill at its end', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TaskStepList task={task({ scanCost: 3500 })} onChange={onChange} canTick />);

    // The accessible name is the row's, and pressing anywhere in it ticks.
    const row = screen.getByRole('button', { name: /Scan/ });
    await user.click(row);

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ done: expect.objectContaining({ scan: true }) }),
    );
  });

  it('gives the row a checkbox-style pressed state rather than a Done label', async () => {
    render(<TaskStepList task={task({ scanCost: 3500 })} onChange={vi.fn()} canTick />);
    expect(screen.getByRole('button', { name: /Scan/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('colours each step by the board stage that performs it', () => {
    render(
      <TaskStepList
        task={task({ scanCost: 3500, modelisationCost: 4500, impressionCost: 1000, usinageCost: 2000 })}
        onChange={vi.fn()}
        canTick
      />,
    );
    expect(screen.getByTestId('step-swatch-scan')).toHaveClass('bg-teal-400');
    expect(screen.getByTestId('step-swatch-modelisation')).toHaveClass('bg-violet-400');
    // Printing and machining share the print column, so they share its colour.
    expect(screen.getByTestId('step-swatch-impression')).toHaveClass('bg-orange-400');
    expect(screen.getByTestId('step-swatch-usinage')).toHaveClass('bg-orange-400');
  });

  it('still renders a step with no toggle when the quote is not accepted', () => {
    render(<TaskStepList task={task({ scanCost: 3500 })} onChange={vi.fn()} canTick={false} />);
    expect(screen.getByText('Scan')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  // The part's physical identity under the printing step. Quantity and colour
  // live on the task; the material NAME has to be resolved from the
  // calculator's filament list, which is the only reason this component
  // fetches anything at all.
  describe('printing meta line', () => {
    const impression = (overrides: Partial<ImpressionDraft> = {}): ImpressionDraft => ({
      ...emptyTaskDraft().impression,
      ...overrides,
    });

    const mockFilaments = (hits?: { count: number }) =>
      server.use(
        http.get('*/api/v1/calculator/filaments/', () => {
          if (hits) hits.count += 1;
          return HttpResponse.json([
            { id: 7, name: 'PLA Basique', brand: '', material: 'PLA', cost_per_kg: 3731, sale_price_per_kg: 5597, difficulty_pct: 100 },
          ]);
        }),
      );

    it('shows quantity, material and colour when all three are set', async () => {
      mockFilaments();
      render(
        <TaskStepList
          task={task({ impression: impression({ quantity: 3, filamentId: 7, color: 'Rouge' }) })}
          onChange={vi.fn()}
          canTick
        />,
      );

      // The material arrives with the filament query; the other two are on the task.
      expect(await screen.findByText('PLA Basique')).toBeInTheDocument();
      const meta = screen.getByTestId('step-meta-impression');
      expect(meta).toHaveTextContent('×3');
      expect(meta).toHaveTextContent('Rouge');
      // Icons are decoration — the field name is what a screen reader gets.
      expect(meta).toHaveTextContent('Quantity');
      expect(meta).toHaveTextContent('Material');
      expect(meta).toHaveTextContent('Colour');
    });

    it('shows a quantity of 1 as ×1, even with no colour and no material', async () => {
      mockFilaments();
      render(
        <TaskStepList
          task={task({ impression: impression({ quantity: 1, filamentId: null, color: '   ' }) })}
          onChange={vi.fn()}
          canTick
        />,
      );

      await screen.findByText('Printing');
      // How many of the part this step prints is what the line is FOR, and a
      // one-off is an answer, not a blank. Leaving ×1 out meant the reader had
      // to know that a missing quantity means one — the line now always says
      // so. Colour and material stay omitted when unset: those really are
      // absent data, not a default worth stating.
      const meta = screen.getByTestId('step-meta-impression');
      expect(meta).toHaveTextContent('×1');
      expect(meta).not.toHaveTextContent('Colour');
      expect(meta).not.toHaveTextContent('Material');
    });

    it('omits a quantity of 0 — that is not a job, and ×0 explains nothing', async () => {
      mockFilaments();
      render(
        <TaskStepList
          task={task({ impression: impression({ quantity: 0, filamentId: null, color: '   ' }) })}
          onChange={vi.fn()}
          canTick
        />,
      );

      await screen.findByText('Printing');
      expect(screen.queryByTestId('step-meta-impression')).not.toBeInTheDocument();
    });

    it('shows the values it has when only some are set', async () => {
      mockFilaments();
      render(
        <TaskStepList
          task={task({ impression: impression({ quantity: 2, filamentId: null, color: 'Noir mat' }) })}
          onChange={vi.fn()}
          canTick
        />,
      );

      const meta = await screen.findByTestId('step-meta-impression');
      expect(meta).toHaveTextContent('×2');
      expect(meta).toHaveTextContent('Noir mat');
      // No filament picked, so no lookup and no material — the other two
      // still render rather than the whole line going missing.
      expect(meta).not.toHaveTextContent('Material');
    });

    it('never renders the line when the task has no printing step', async () => {
      mockFilaments();
      render(
        <TaskStepList
          task={task({
            impressionCost: null,
            scanCost: 3500,
            impression: impression({ quantity: 4, filamentId: 7, color: 'Rouge' }),
          })}
          onChange={vi.fn()}
          canTick
        />,
      );

      await screen.findByText('Scan');
      expect(screen.queryByTestId('step-meta-impression')).not.toBeInTheDocument();
    });

    it('renders above the step description rather than replacing it', async () => {
      mockFilaments();
      render(
        <TaskStepList
          task={task({
            impression: impression({ quantity: 2, filamentId: 7, color: 'Blanc' }),
            impressionDescription: 'Remplissage 40 %',
          })}
          onChange={vi.fn()}
          canTick
        />,
      );

      const meta = await screen.findByTestId('step-meta-impression');
      const desc = screen.getByTestId('step-desc-impression');
      expect(desc).toHaveTextContent('Remplissage 40 %');
      // DOCUMENT_POSITION_FOLLOWING: the description comes after the meta line.
      expect(meta.compareDocumentPosition(desc) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('does not fetch the filament list when no printing step names a filament', async () => {
      const hits = { count: 0 };
      mockFilaments(hits);
      render(
        <TaskStepList
          task={task({ impression: impression({ quantity: 5, color: 'Rouge' }) })}
          onChange={vi.fn()}
          canTick
        />,
      );

      // The line still renders — quantity and colour need no lookup.
      const meta = await screen.findByTestId('step-meta-impression');
      expect(meta).toHaveTextContent('×5');
      await waitFor(() => expect(hits.count).toBe(0));
    });
  });
});
