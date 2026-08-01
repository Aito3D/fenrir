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
    render(<StageRail tasks={tasks} column="scan" moveLock="steps" currency="XPF" />);
    ['Quote', 'Waiting', 'Scan', 'Modeling', 'Printing & Machining', 'Finish', 'Done'].forEach((label) =>
      expect(screen.getByText(label)).toBeInTheDocument(),
    );
  });

  it('is read-only — a column is derived, so nothing here is pressable', () => {
    render(<StageRail tasks={tasks} column="scan" moveLock="steps" currency="XPF" />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('marks the current stage and reports progress for each stage that owns work', () => {
    render(<StageRail tasks={tasks} column="scan" moveLock="steps" currency="XPF" />);
    expect(screen.getByTestId('stage-node-scan')).toHaveAttribute('data-state', 'current');
    expect(screen.getByTestId('stage-node-devis')).toHaveAttribute('data-state', 'past');
    expect(screen.getByTestId('stage-node-print')).toHaveAttribute('data-state', 'future');
    expect(screen.getByTestId('stage-bar-scan')).toHaveStyle({ width: '100%' });
    expect(screen.getByTestId('stage-bar-print')).toHaveStyle({ width: '0%' });
  });

  it('renders no bar for a stage that owns no work', () => {
    render(<StageRail tasks={tasks} column="scan" moveLock="steps" currency="XPF" />);
    expect(screen.queryByTestId('stage-bar-finish')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stage-bar-model')).toBeInTheDocument();
  });

  it('explains why the card is parked, naming the stage', () => {
    render(<StageRail tasks={tasks} column="scan" moveLock="steps" currency="XPF" />);
    expect(screen.getByText(/Parked in Scan until every Scan step is ticked\./)).toBeInTheDocument();
  });

  it('explains each of the other locks', () => {
    const { rerender } = render(<StageRail tasks={tasks} column="devis" moveLock="quote" currency="XPF" />);
    expect(screen.getByText('Waiting for the quote to be accepted.')).toBeInTheDocument();

    rerender(<StageRail tasks={tasks} column="waiting" moveLock="waiting" currency="XPF" />);
    expect(screen.getByText('Out with the client.')).toBeInTheDocument();

    rerender(<StageRail tasks={tasks} column="done" moveLock="declined" currency="XPF" />);
    expect(screen.getByText('The quote was declined.')).toBeInTheDocument();
  });

  it('gives the progress bar the same formatted amount the visible caption shows', () => {
    // Regression: the bar's aria-label used to interpolate the raw number
    // (`amount: `${stage.value - stage.valueDone}`) while the <Money> caption
    // right beside it used formatMoney — "10000 left" next to "10 000 FCFP".
    // Screen-reader and sighted users must be told the same figure. Same fix
    // as ValueRing's in ProjectDetailPanel.
    render(<StageRail tasks={tasks} column="scan" moveLock="steps" currency="XPF" />);
    const bar = screen.getByTestId('stage-bar-print');
    const progressbar = bar.closest('[role="progressbar"]');
    expect(progressbar).not.toBeNull();
    expect(progressbar!.getAttribute('aria-label')).toContain(formatMoney(10000, 'XPF'));
    // The old label had no thousands separator and no unit — this fails
    // against the raw-number regression directly, not just by omission.
    expect(progressbar!.getAttribute('aria-label')).not.toContain('10000');
  });

  it('says nothing when the card is free to move', () => {
    render(<StageRail tasks={tasks} column="finish" moveLock={null} currency="XPF" />);
    expect(screen.queryByTestId('stage-lock')).not.toBeInTheDocument();
  });
});
