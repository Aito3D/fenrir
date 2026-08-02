import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { TaskStepFields } from '../../components/aito/TaskStepFields';
import { emptyTaskDraft } from '../../utils/taskDraft';

describe('TaskStepFields', () => {
  it('shows all four services as chips even when no step exists yet', () => {
    // Every service starts as a chip, not a rendered block, on an empty
    // draft — but the chip itself still carries the service's label, so the
    // name stays discoverable.
    render(<TaskStepFields task={emptyTaskDraft()} onChange={vi.fn()} />);
    for (const label of ['Scan', 'Modeling', 'Printing', 'Machining']) {
      expect(screen.getByRole('button', { name: `Add ${label}` })).toBeInTheDocument();
    }
    // No cost input renders until its chip is switched on.
    expect(screen.queryByLabelText(/scan cost/i)).not.toBeInTheDocument();
  });

  it('clearing a cost emits null, not zero — absent is not free', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    // A non-null cost seeds the chip open, so the input is already there.
    render(<TaskStepFields task={{ ...emptyTaskDraft(), scanCost: 1200 }} onChange={onChange} />);

    await user.clear(screen.getByLabelText(/scan cost/i));
    expect(onChange.mock.calls.at(-1)?.[0].scanCost).toBeNull();
  });

  it('typing 0 emits 0, which is a real free step', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TaskStepFields task={emptyTaskDraft()} onChange={onChange} />);

    // Machining is a chip on an empty draft; enable it to reach its cost
    // input — enabling must not itself invent a price.
    await user.click(screen.getByRole('button', { name: 'Add Machining' }));
    await user.type(screen.getByLabelText(/machining cost/i), '0');
    expect(onChange.mock.calls.at(-1)?.[0].usinageCost).toBe(0);
  });
});
