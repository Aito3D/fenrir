import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { ReadingTimeline } from '../../components/maintenance/hours/ReadingTimeline';
import type { HourReading } from '../../api/client';

const r = (id: number, machine_id: number, reading_date: string, hours: number): HourReading => ({
  id, machine_id, reading_date, hours, source: 'manual', raw_hours: null,
});
const readings = [
  r(1, 1, '2025-10-01', 100),
  r(2, 1, '2026-01-01', 300),
  r(3, 2, '2026-01-01', 50),
  r(4, 1, '2026-04-25', 500),
];

describe('ReadingTimeline', () => {
  it('one dot per manual date, click picks the date', async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(<ReadingTimeline readings={readings} today="2026-05-01" due={false} onPick={onPick} />);
    const dots = screen.getAllByTestId('hours-timeline-dot');
    expect(dots).toHaveLength(3);
    expect(dots[1].getAttribute('aria-label')).toContain('Machines: 2');
    await user.click(dots[1]);
    expect(onPick).toHaveBeenCalledWith('2026-01-01');
  });

  it('due shows the today marker', () => {
    const { rerender } = render(<ReadingTimeline readings={readings} today="2026-05-01" due onPick={vi.fn()} />);
    expect(screen.getByTestId('hours-timeline-today')).toBeInTheDocument();
    rerender(<ReadingTimeline readings={readings} today="2026-05-01" due={false} onPick={vi.fn()} />);
    expect(screen.queryByTestId('hours-timeline-today')).not.toBeInTheDocument();
  });
});
