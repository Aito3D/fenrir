import { describe, expect, it } from 'vitest';
import { render, screen } from '../utils';
import { CreateChecklist, Line } from '../../components/aito/CreateChecklist';
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

  it('shows the social handle as the contact when it is the only reachable channel', () => {
    // Pins NewProjectDrawer's `clientContact={phone || email || socialHandle}`
    // (drawer:555) — a social-only client (no phone, no email) must not show
    // "Client reachable — " with nothing after the dash.
    renderChecklist({ ...base, clientReachable: true, clientContact: 'moana.raiatea' });
    expect(screen.getByText('Client reachable — moana.raiatea')).toBeInTheDocument();
  });

  it('client line stays neutral until revealed, then goes miss', () => {
    const { rerender } = renderChecklist({ ...base });
    expect(screen.getByText('Client needs a phone, an email or a social network').closest('[data-state]')).toHaveAttribute('data-state', 'wait');
    rerender(<CreateChecklist {...base} clientRevealed />);
    expect(screen.getByText('Client needs a phone, an email or a social network').closest('[data-state]')).toHaveAttribute('data-state', 'miss');
  });

  it('a satisfied line grows its tick in and transitions its colours', () => {
    renderChecklist({ ...base });
    const line = screen.getByText('2 tasks — at least one required').closest('[data-state]') as HTMLElement;
    expect(line.className).toContain('transition-colors');
    expect(line.querySelector('svg')).toHaveClass('animate-tick-in');
  });

  it('zero tasks is structural — miss without any reveal', () => {
    renderChecklist({ ...base, taskCount: 0 });
    expect(screen.getByText('A project needs at least one task — add one').closest('[data-state]')).toHaveAttribute('data-state', 'miss');
  });

  it('exports Line for reuse by other checklists', () => {
    render(<Line state="ok" text="Reused line" />);
    const line = screen.getByText('Reused line').closest('[data-state]');
    expect(line).toHaveAttribute('data-state', 'ok');
  });
});
