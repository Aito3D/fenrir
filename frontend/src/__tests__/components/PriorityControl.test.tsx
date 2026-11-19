import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { PriorityControl } from '../../components/PriorityControl';
import { formatMoney } from '../../utils/pricing';

describe('PriorityControl', () => {
  it('selects Urgent on click', async () => {
    const onChange = vi.fn();
    render(<PriorityControl value="normal" onChange={onChange} surcharge={0} currency="USD" />);
    await userEvent.click(screen.getByRole('radio', { name: 'Urgent' }));
    expect(onChange).toHaveBeenCalledWith('urgent');
  });

  it('moves to Priority with ArrowRight from Normal', async () => {
    const onChange = vi.fn();
    render(<PriorityControl value="normal" onChange={onChange} surcharge={0} currency="USD" />);
    screen.getByRole('radio', { name: 'Normal' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('priority');
  });

  it('shows the surcharge chip only when above zero', () => {
    const { rerender } = render(<PriorityControl value="priority" onChange={() => {}} surcharge={12.5} currency="USD" />);
    expect(screen.getByText(`+${formatMoney(12.5, 'USD')}`)).toBeInTheDocument();
    rerender(<PriorityControl value="normal" onChange={() => {}} surcharge={0} currency="USD" />);
    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();
  });
});
