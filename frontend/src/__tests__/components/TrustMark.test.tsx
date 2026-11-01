import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../utils';
import { TrustMark } from '../../components/maintenance/hours/TrustMark';
import type { HourMachine } from '../../api/client';

const base: HourMachine = {
  id: 1, printer_id: 6, name: 'X1C04', model: 'X1C', retired: false, current_hours: 100,
  trust: 'calibrated', last_drift_hours: null, calibrated_at: null, counter_raw_hours: null,
  next_service_hours: null, purchase_price: null, purchase_date: null, added_on: null,
};

describe('TrustMark', () => {
  it('renders nothing for calibrated and null', () => {
    const { rerender } = render(<TrustMark machine={base} />);
    expect(screen.queryByRole('img')).toBeNull();
    rerender(<TrustMark machine={{ ...base, trust: null }} />);
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('shows the drift in hours when drifting', () => {
    render(<TrustMark machine={{ ...base, trust: 'drifting', last_drift_hours: -12.4 }} />);
    const mark = screen.getByRole('img', { name: 'Counter was 12 h off at the last reading' });
    expect(mark).toHaveAttribute('title', 'Counter was 12 h off at the last reading');
  });

  it('flags an uncalibrated counter', () => {
    render(<TrustMark machine={{ ...base, trust: 'uncalibrated' }} />);
    expect(screen.getByRole('img', { name: 'Counter not calibrated' })).toBeInTheDocument();
  });
});
