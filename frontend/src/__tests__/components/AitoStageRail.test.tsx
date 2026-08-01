import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StageRail } from '../../components/aito/StageRail';
import { formatMoney } from '../../utils/pricing';
import type { TaskDraft } from '../../utils/taskDraft';

function task(overrides: Partial<TaskDraft> = {}): TaskDraft {
  return {
    id: null, uid: 'u1', title: '', description: '',
    scanCost: null, modelisationCost: null, impressionCost: null, usinageCost: null,
    done: { scan: false, modelisation: false, impression: false, usinage: false },
    ...overrides,
  } as TaskDraft;
}

const tasks = [
  task({ uid: 'a', scanCost: 3500, modelisationCost: 4500, impressionCost: 10000,
         done: { scan: true, modelisation: true, impression: false, usinage: false } }),
];

describe('StageRail', () => {
  it('lists every board column, including the ones that own no work', () => {
    render(<StageRail tasks={tasks} column="scan" currency="XPF" />);
    ['Quote', 'Waiting', 'Scan', 'Modeling', 'Printing & Machining', 'Finish', 'Done'].forEach((label) =>
      expect(screen.getByText(label)).toBeInTheDocument(),
    );
  });

  it('is read-only — a column is derived, so nothing here is pressable', () => {
    render(<StageRail tasks={tasks} column="scan" currency="XPF" />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('marks the current stage and reports progress for each stage that owns work', () => {
    render(<StageRail tasks={tasks} column="scan" currency="XPF" />);
    expect(screen.getByTestId('stage-node-scan')).toHaveAttribute('data-state', 'current');
    expect(screen.getByTestId('stage-node-devis')).toHaveAttribute('data-state', 'past');
    expect(screen.getByTestId('stage-node-print')).toHaveAttribute('data-state', 'future');
    expect(screen.getByTestId('stage-bar-scan')).toHaveStyle({ width: '100%' });
    expect(screen.getByTestId('stage-bar-print')).toHaveStyle({ width: '0%' });
  });

  it('renders no bar for a stage that owns no work', () => {
    render(<StageRail tasks={tasks} column="scan" currency="XPF" />);
    expect(screen.queryByTestId('stage-bar-finish')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stage-bar-model')).toBeInTheDocument();
  });



  it('gives the progress bar the same formatted amount the visible caption shows', () => {
    // Regression: the bar's aria-label used to interpolate the raw number
    // (`amount: `${stage.value - stage.valueDone}`) while the <Money> caption
    // right beside it used formatMoney — "10000 left" next to "10 000 FCFP".
    // Screen-reader and sighted users must be told the same figure. Same fix
    // as ValueRing's in ProjectDetailPanel.
    render(<StageRail tasks={tasks} column="scan" currency="XPF" />);
    const bar = screen.getByTestId('stage-bar-print');
    const progressbar = bar.closest('[role="progressbar"]');
    expect(progressbar).not.toBeNull();
    expect(progressbar!.getAttribute('aria-label')).toContain(formatMoney(10000, 'XPF'));
    // The old label had no thousands separator and no unit — this fails
    // against the raw-number regression directly, not just by omission.
    expect(progressbar!.getAttribute('aria-label')).not.toContain('10000');
  });

});
