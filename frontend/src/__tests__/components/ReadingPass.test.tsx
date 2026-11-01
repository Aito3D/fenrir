import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { ReadingPass } from '../../components/maintenance/hours/ReadingPass';
import type { HourMachine, HourReading } from '../../api/client';

const base = {
  trust: 'uncalibrated' as const, last_drift_hours: null, calibrated_at: null, next_service_hours: null,
  purchase_price: null, purchase_date: null, added_on: null, retired: false, printer_id: null,
};
const machines: HourMachine[] = [
  { ...base, id: 1, name: 'X1C04', model: 'X1C', current_hours: 4000, counter_raw_hours: 1112 },
  { ...base, id: 2, name: 'H2S02', model: 'H2S', current_hours: 1200, counter_raw_hours: null },
  { ...base, id: 3, name: 'A101', model: 'A1', current_hours: null, counter_raw_hours: null },
];
const readings: HourReading[] = [
  { id: 1, machine_id: 1, reading_date: '2026-04-25', hours: 3803, source: 'manual', raw_hours: null },
  { id: 2, machine_id: 1, reading_date: '2026-04-25', hours: 3803, source: 'auto', raw_hours: 500 },
  { id: 3, machine_id: 2, reading_date: '2026-04-25', hours: 906, source: 'manual', raw_hours: null },
];

function setup() {
  const onSave = vi.fn();
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(
    <ReadingPass machines={machines} readings={readings} today="2031-02-14" colors={new Map()}
      isSaving={false} onSave={onSave} onClose={onClose} />,
  );
  return { user, onSave, onClose };
}

describe('ReadingPass', () => {
  it('walks machines in order, Enter advances, blank skips', async () => {
    const { user } = setup();
    expect(screen.getByRole('heading', { name: 'X1C04' })).toBeInTheDocument();
    expect(screen.getByText('1 / 3')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'X1C04' }), '4400{Enter}');
    expect(screen.getByRole('heading', { name: 'H2S02' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'H2S02' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('heading', { name: 'A101' })).toBeInTheDocument();
    expect(screen.getByText('no reading yet')).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('heading', { name: 'Check and save' })).toBeInTheDocument();
    const rows = screen.getAllByTestId('pass-summary-row');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText('X1C04')).toBeInTheDocument();
    expect(within(rows[0]).getByText('+597 h')).toBeInTheDocument();
  });

  it('questions a backwards value and keeps it on a second Enter', async () => {
    const { user } = setup();
    await user.type(screen.getByRole('textbox', { name: 'X1C04' }), '3700');
    expect(screen.getByText(/Lower than the 3,803 h read on/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep anyway' })).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('heading', { name: 'H2S02' })).toBeInTheDocument();
    await user.keyboard('{Enter}{Enter}');
    expect(within(screen.getByTestId('pass-summary-row')).getByText('kept')).toBeInTheDocument();
  });

  it('questions a jump far from the counter', async () => {
    const { user } = setup();
    expect(screen.getByText(/Fenrir counted \+612 h since/)).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'X1C04' }), '4800');
    expect(screen.getByText(/Expected about 4,415 h/)).toBeInTheDocument();
  });

  it('blocks Next on an invalid value and Skip clears it', async () => {
    const { user } = setup();
    await user.type(screen.getByRole('textbox', { name: 'X1C04' }), '12a');
    expect(screen.getByText('Not a number')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(screen.getByRole('heading', { name: 'H2S02' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('textbox', { name: 'X1C04' })).toHaveValue('');
  });

  it('summary lists only filled machines and saves them', async () => {
    const { user, onSave } = setup();
    await user.type(screen.getByRole('textbox', { name: 'X1C04' }), '4400{Enter}{Enter}{Enter}');
    await user.click(screen.getByRole('button', { name: 'Save 1 readings' }));
    expect(onSave).toHaveBeenCalledWith([{ machine_id: 1, hours: 4400 }]);
  });

  it('Escape closes', async () => {
    const { user, onClose } = setup();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
