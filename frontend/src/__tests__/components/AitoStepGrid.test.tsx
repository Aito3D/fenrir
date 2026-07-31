import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../utils';
import { StepGrid } from '../../components/aito/StepGrid';

describe('StepGrid', () => {
  it('renders nothing for a project with no tasks', () => {
    // Not `toBeEmptyDOMElement()` on the whole container: the shared `render`
    // helper always mounts `ToastProvider`, which injects its own
    // `toast-viewport` div into every tree regardless of children, so the
    // container is never literally empty. Every other aito test on this
    // helper (e.g. AitoQuotePrintButton.test.tsx) asserts the absence of the
    // component's own output instead, for the same reason.
    render(<StepGrid tasks={[]} />);
    expect(screen.queryByTestId('aito-step-row')).not.toBeInTheDocument();
  });

  it('draws one row per task', () => {
    render(
      <StepGrid
        tasks={[
          { services: ['scan'], done: [] },
          { services: ['impression'], done: [] },
        ]}
      />,
    );
    expect(screen.getAllByTestId('aito-step-row')).toHaveLength(2);
  });

  it('marks a ticked step done and an untouched one not', async () => {
    render(<StepGrid tasks={[{ services: ['scan', 'impression'], done: ['scan'] }]} />);
    expect(await screen.findByText('Scan')).toHaveAttribute('data-done', 'true');
    expect(screen.getByText('Printing')).toHaveAttribute('data-done', 'false');
  });

  it('omits a service the task does not carry, keeping four columns', () => {
    render(<StepGrid tasks={[{ services: ['scan', 'impression'], done: [] }]} />);
    expect(screen.queryByText('Modeling')).not.toBeInTheDocument();
    expect(screen.queryByText('Machining')).not.toBeInTheDocument();
    // The empty cells still exist, or the pills would slide left and the
    // columns would stop lining up between rows.
    expect(screen.getByTestId('aito-step-row').children).toHaveLength(4);
  });

  it('orders the pills canonically regardless of the order given', async () => {
    render(<StepGrid tasks={[{ services: ['usinage', 'scan', 'modelisation'], done: [] }]} />);
    const labels = Array.from(screen.getByTestId('aito-step-row').children).map((cell) =>
      cell.textContent,
    );
    expect(labels).toEqual(['Scan', 'Modeling', '', 'Machining']);
    expect(await screen.findByText('Scan')).toBeInTheDocument();
  });

  it('ignores a done id the task does not actually carry', () => {
    // Defensive: a stale optimistic write must not paint a pill that is not
    // there, and must not crash the card either.
    render(<StepGrid tasks={[{ services: ['scan'], done: ['scan', 'usinage'] }]} />);
    expect(screen.queryByText('Machining')).not.toBeInTheDocument();
  });

  it('renders a task with no priced service as an empty row', () => {
    render(<StepGrid tasks={[{ services: [], done: [] }]} />);
    expect(screen.getByTestId('aito-step-row').textContent).toBe('');
  });
});
