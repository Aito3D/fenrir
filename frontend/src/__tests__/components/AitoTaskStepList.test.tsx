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
    render(<TaskStepList task={task()} onChange={vi.fn()} />);
    expect(screen.getByText('Scan')).toBeInTheDocument();
    expect(screen.getByText('Printing')).toBeInTheDocument();
    expect(screen.queryByText('Modeling')).not.toBeInTheDocument();
    expect(screen.queryByText('Machining')).not.toBeInTheDocument();
  });

  it('shows a step quoted at zero, because free is not absent', () => {
    render(<TaskStepList task={task({ modelisationCost: 0 })} onChange={vi.fn()} />);
    expect(screen.getByText('Modeling')).toBeInTheDocument();
  });

  it('reports a tick upward without mutating the task', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const original = task();
    render(<TaskStepList task={original} onChange={onChange} />);

    await user.click(screen.getAllByRole('button', { name: /mark done/i })[0]);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].done.scan).toBe(true);
    expect(original.done.scan).toBe(false);
  });

  it('un-ticks in one click — undo must be cheap', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const ticked = task({ done: { scan: true, modelisation: false, impression: false, usinage: false } });
    render(<TaskStepList task={ticked} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: /mark not done/i }));
    expect(onChange.mock.calls[0][0].done.scan).toBe(false);
  });

  it('says so when a task has no steps yet', () => {
    render(<TaskStepList task={emptyTaskDraft()} onChange={vi.fn()} />);
    expect(screen.getByText(/no steps yet/i)).toBeInTheDocument();
  });
});
