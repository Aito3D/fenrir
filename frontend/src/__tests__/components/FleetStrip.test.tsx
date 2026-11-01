import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { FleetStrip } from '../../components/maintenance/hours/FleetStrip';
import type { HourMachine } from '../../api/client';

const mk = (id: number, name: string, model: string, retired = false): HourMachine => ({
  id, printer_id: null, name, model, retired, current_hours: null, trust: 'uncalibrated',
  last_drift_hours: null, calibrated_at: null, counter_raw_hours: null, next_service_hours: null,
  purchase_price: null, purchase_date: null, added_on: null,
});

const machines = [
  mk(1, 'H2S02', 'H2S'),
  mk(5, 'H2S04', 'H2S'),
  mk(6, 'H2S05', 'H2S'),
  mk(9, 'H2S01', 'H2S', true),
];
const facts = { lifetime: 37115, thisMonth: 1980, due: 14, busiest: { id: 5, pace: 228 } };
const paces = new Map<number, number | null>([[1, 135], [5, 228], [6, null], [9, 400]]);

describe('FleetStrip', () => {
  it('shows the four facts from the helper', () => {
    render(<FleetStrip facts={facts} machines={machines} paces={paces} onTakeReadings={vi.fn()} />);
    expect(screen.getByText('37,115 h')).toBeInTheDocument();
    expect(screen.getByText('1,980 h')).toBeInTheDocument();
    expect(screen.getByText('14')).toBeInTheDocument();
    expect(screen.getByText('H2S04')).toBeInTheDocument();
    expect(screen.getByText('228 h/month')).toBeInTheDocument();
  });

  it('readings due tile opens the pass callback', async () => {
    const onTake = vi.fn();
    render(<FleetStrip facts={facts} machines={machines} paces={paces} onTakeReadings={onTake} />);
    await userEvent.click(screen.getByRole('button', { name: 'Take readings' }));
    expect(onTake).toHaveBeenCalledTimes(1);
  });

  it('expanding lists load bars sorted by share with stale machines last', async () => {
    render(<FleetStrip facts={facts} machines={machines} paces={paces} onTakeReadings={vi.fn()} />);
    expect(screen.queryAllByTestId('hours-load-row')).toHaveLength(0);
    const chevron = screen.getByRole('button', { name: 'Load per machine' });
    expect(chevron).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(chevron);
    expect(chevron).toHaveAttribute('aria-expanded', 'true');
    const rows = screen.getAllByTestId('hours-load-row');
    expect(rows.map((r) => r.getAttribute('data-name'))).toEqual(['H2S04', 'H2S02', 'H2S05']);
    expect(within(rows[2]).getByText('no recent reading')).toBeInTheDocument();
    expect(screen.queryByText('H2S01')).not.toBeInTheDocument();
    expect(rows[0].querySelector('i')).toHaveStyle({ width: '31%' });
    expect(within(rows[0]).getByText('31 %')).toBeInTheDocument();
  });
});
