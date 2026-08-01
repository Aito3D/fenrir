import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { TaskStepList } from '../../components/aito/TaskStepList';
import { emptyTaskDraft } from '../../utils/taskDraft';
import type { TaskDraft } from '../../utils/taskDraft';

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
});
