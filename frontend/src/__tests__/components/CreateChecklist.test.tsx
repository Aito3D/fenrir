import { describe, expect, it } from 'vitest';
import { render, screen } from '../utils';
import { CreateChecklist } from '../../components/aito/CreateChecklist';
import type { CreateChecklistProps } from '../../components/aito/CreateChecklist';

const base: CreateChecklistProps = {
  taskCount: 2,
  revealedUnpricedName: null,
  hasUnpriced: false,
  summaryState: 'ready',
  clientAccountName: 'Client de passage',
  clientReachable: false,
  clientContact: '',
  clientRevealed: false,
};

function renderChecklist(props: CreateChecklistProps) {
  return render(<CreateChecklist {...props} />);
}

describe('CreateChecklist', () => {
  it('names a blur-revealed unpriced task', () => {
    renderChecklist({ ...base, hasUnpriced: true, revealedUnpricedName: 'Support antenne' });
    expect(screen.getByText('"Support antenne" needs at least one priced sub-task')).toBeInTheDocument();
  });

  it('keeps the sub-task line neutral before blur', () => {
    renderChecklist({ ...base, hasUnpriced: true });
    const line = screen.getByText('Each task needs at least one priced sub-task');
    expect(line.closest('[data-state]')).toHaveAttribute('data-state', 'wait');
  });

  it('client line stays neutral until revealed, then goes miss', () => {
    const { rerender } = renderChecklist({ ...base });
    expect(screen.getByText('Client needs a phone or an email').closest('[data-state]')).toHaveAttribute('data-state', 'wait');
    rerender(<CreateChecklist {...base} clientRevealed />);
    expect(screen.getByText('Client needs a phone or an email').closest('[data-state]')).toHaveAttribute('data-state', 'miss');
  });

  it('zero tasks is structural — miss without any reveal', () => {
    renderChecklist({ ...base, taskCount: 0 });
    expect(screen.getByText('A project needs at least one task — add one').closest('[data-state]')).toHaveAttribute('data-state', 'miss');
  });
});
