import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueueStatsBar } from '../../components/QueueStatsBar';

const t = (key: string) => key;
const props = { activeCount: 1, pendingCount: 4, totalTime: 5400, totalWeight: 1250, historyCount: 12, t };

describe('QueueStatsBar', () => {
  it('renders the five stats in a box by default', () => {
    render(<QueueStatsBar {...props} />);
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('1.3kg')).toBeInTheDocument();
    expect(screen.queryByTestId('queue-stats-compact')).not.toBeInTheDocument();
  });

  it('compact: one scrolling line, same stats', () => {
    render(<QueueStatsBar {...props} compact />);
    const line = screen.getByTestId('queue-stats-compact');
    expect(line.className).toContain('overflow-x-auto');
    expect(line.className).toContain('flex-nowrap');
    expect(screen.getByText('12')).toBeInTheDocument();
  });
});
