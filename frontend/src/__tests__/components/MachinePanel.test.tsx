import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { MachinePanel } from '../../components/maintenance/hours/MachinePanel';
import { machineSeries } from '../../utils/hoursSeries';
import { formatMoney } from '../../utils/pricing';
import type { HourEvent, HourMachine, HourReading } from '../../api/client';

const machine: HourMachine = {
  id: 5, printer_id: 9, name: 'H2S04', model: 'H2S', retired: false, current_hours: 1743,
  trust: 'uncalibrated', last_drift_hours: null, calibrated_at: null, counter_raw_hours: null,
  next_service_hours: 2500, purchase_price: null, purchase_date: null, added_on: '2026-01-01',
};
const readings: HourReading[] = [
  { id: 1, machine_id: 5, reading_date: '2026-01-01', hours: 890, source: 'manual', raw_hours: null },
  { id: 2, machine_id: 5, reading_date: '2026-04-25', hours: 1743, source: 'manual', raw_hours: null },
  { id: 3, machine_id: 5, reading_date: '2026-04-25', hours: 1743, source: 'auto', raw_hours: 1743 },
];
const events: HourEvent[] = [
  { id: 11, machine_id: 5, event_date: '2026-01-01', kind: 'added', label: 'Added', source_id: null },
  { id: 12, machine_id: 5, event_date: '2026-03-01', kind: 'note', label: 'hotend changed', source_id: null },
];

function setup(over: Partial<React.ComponentProps<typeof MachinePanel>> = {}, m: HourMachine = machine, rs: HourReading[] = readings) {
  const props = {
    machine: m, series: machineSeries(rs, m.id), readings: rs, events, today: '2026-05-10', color: '#0af',
    currency: 'USD', canEdit: true,
    onEditDate: vi.fn(), onAddEvent: vi.fn(), onDeleteEvent: vi.fn(), onSavePurchase: vi.fn(), onClose: vi.fn(),
    ...over,
  };
  render(<MachinePanel {...props} />);
  return props;
}

describe('MachinePanel', () => {
  it('header shows trust help and added date', async () => {
    const p = setup();
    const header = screen.getByTestId('hours-panel-header');
    expect(screen.getByRole('dialog')).toHaveAccessibleName('H2S04');
    expect(within(header).getByText(/Fenrir counts from 0/)).toBeInTheDocument();
    expect(within(header).getByText(/added/)).toBeInTheDocument();
    await userEvent.click(within(header).getByRole('button', { name: 'Take a reading' }));
    expect(p.onEditDate).toHaveBeenCalledWith('2026-05-10');
  });

  it('lists period paces and a flag', () => {
    const rs: HourReading[] = [
      { id: 1, machine_id: 5, reading_date: '2026-01-01', hours: 0, source: 'manual', raw_hours: null },
      { id: 2, machine_id: 5, reading_date: '2026-03-01', hours: 600, source: 'manual', raw_hours: null },
      { id: 3, machine_id: 5, reading_date: '2026-05-01', hours: 700, source: 'manual', raw_hours: null },
    ];
    setup({}, machine, rs);
    expect(screen.getAllByText(/h\/month/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('slowing')).toBeInTheDocument();
  });

  it('shows one period without a flag, and the forecast', () => {
    setup();
    expect(screen.getAllByText('228 h/month').length).toBeGreaterThan(0);
    expect(screen.queryByText('slowing')).toBeNull();
    expect(screen.getByText(/At \d+ h\/month, 2,500 h around/)).toBeInTheDocument();
    expect(screen.getAllByTestId('hours-panel-reading')).toHaveLength(2);
  });

  it('adds and deletes a note', async () => {
    const p = setup();
    await userEvent.type(screen.getByLabelText('Note'), 'belt changed');
    await userEvent.click(screen.getByRole('button', { name: 'Save note' }));
    expect(p.onAddEvent).toHaveBeenCalledWith(5, { event_date: '2026-05-10', label: 'belt changed' });
    const del = screen.getAllByRole('button', { name: 'Delete note' });
    expect(del).toHaveLength(1);
    await userEvent.click(del[0]);
    expect(p.onDeleteEvent).toHaveBeenCalledWith(12);
  });

  it('cost per hour uses the app currency', () => {
    setup({ currency: 'XPF' }, { ...machine, purchase_price: 347000 });
    const expected = formatMoney(347000 / 1743, 'XPF');
    const norm = (x: string) => x.replace(/\s/g, ' ');
    expect(screen.getByText((_, el) => el?.tagName === 'P' && norm(el.firstChild?.textContent ?? '') === norm(`${expected} per hour`))).toBeInTheDocument();
    expect(screen.getByText(/based on the last reading of/)).toBeInTheDocument();
    expect(screen.getByText('Revenue per machine is not tracked.')).toBeInTheDocument();
  });

  it('saves purchase details, blank as null', async () => {
    const p = setup();
    await userEvent.type(screen.getByLabelText('Purchase price'), '1200');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(p.onSavePurchase).toHaveBeenCalledWith(5, { purchase_price: 1200, purchase_date: null });
  });

  it('retired machine hides pace and cost', () => {
    setup({}, { ...machine, retired: true });
    expect(screen.queryByText('Pace')).toBeNull();
    expect(screen.queryByText('Cost per hour')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Take a reading' })).toBeNull();
    expect(screen.getByText('Readings')).toBeInTheDocument();
    expect(screen.getByText('Events')).toBeInTheDocument();
  });

  it('Escape and the backdrop close it', async () => {
    const p = setup();
    await userEvent.keyboard('{Escape}');
    expect(p.onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByTestId('hours-panel-backdrop'));
    expect(p.onClose).toHaveBeenCalledTimes(2);
  });
});
