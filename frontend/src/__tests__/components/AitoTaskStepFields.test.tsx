import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { TaskStepFields } from '../../components/aito/TaskStepFields';
import { emptyTaskDraft } from '../../utils/taskDraft';

describe('TaskStepFields', () => {
  it('shows all four step blocks even when no step exists yet', () => {
    render(<TaskStepFields task={emptyTaskDraft()} onChange={vi.fn()} />);
    for (const label of ['Scan', 'Modeling', 'Printing', 'Machining']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('clearing a cost emits null, not zero — absent is not free', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TaskStepFields task={{ ...emptyTaskDraft(), scanCost: 1200 }} onChange={onChange} />);

    await user.clear(screen.getByLabelText(/scan cost/i));
    expect(onChange.mock.calls.at(-1)?.[0].scanCost).toBeNull();
  });

  it('typing 0 emits 0, which is a real free step', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TaskStepFields task={emptyTaskDraft()} onChange={onChange} />);

    await user.type(screen.getByLabelText(/machining cost/i), '0');
    expect(onChange.mock.calls.at(-1)?.[0].usinageCost).toBe(0);
  });
});
