/**
 * T-121: the daily-hours "Update profile" action must never be offered for a
 * measured figure the API would reject. `daily_usage_hours` is bounded
 * `gt=0, le=24` (backend/app/schemas/calculator.py), but `_daily_usage` has
 * no plausibility band of its own, so a handful of very short or
 * overlapping print-log entries can produce a measured value that rounds to
 * 0 (or, at the top, above 24) once posted — a 422 the operator used to see
 * as a bare, field-name-stripped "Input should be greater than 0" toast.
 *
 * The card now computes the exact value `onUpdatePrinterProfile` would post
 * (`Math.round(measured * 10) / 10`) and only renders the action when that
 * value is actually postable. These tests pin both rounding boundaries
 * exactly, and confirm the row itself — label, assumed/measured figures —
 * stays visible either way: only the action is withheld, per the
 * user-approved contract (this is NOT the "hide the row" variant the
 * auditor also offered).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { CalculatorRealityCheckCard } from '../../components/calculator/CalculatorRealityCheckCard';
import type { RealityCheck } from '../../utils/calculatorInsights';

const baseCheck: RealityCheck = {
  kind: 'dailyHours',
  assumed: 5,
  measured: 0.04,
  sample: 5,
  scope: null,
  severity: 'significant',
  printerId: 1,
};

function renderCard(
  check: RealityCheck,
  onUpdatePrinterProfile: (id: number, patch: object) => void = vi.fn(),
  onDismiss: (key: string) => void = () => {},
) {
  render(
    <CalculatorRealityCheckCard
      checks={[check]}
      impacts={{}}
      currency="USD"
      applied={{}}
      onApply={() => {}}
      onApplyAll={() => {}}
      onRevert={() => {}}
      onSaveDefault={() => {}}
      onUpdateFilamentCost={() => {}}
      onUpdatePrinterProfile={onUpdatePrinterProfile}
      onDismiss={onDismiss}
      dismissedCount={0}
      onRestoreDismissed={() => {}}
      canUpdate
      allClear={false}
    />,
  );
}

describe('CalculatorRealityCheckCard: dailyHours Update profile gating (T-121)', () => {
  it('withholds the action just below the low boundary (0.04h posts to 0h, rejected by the API) but keeps the row visible', async () => {
    renderCard({ ...baseCheck, measured: 0.04 });

    expect(await screen.findByText('Daily usage', {}, { timeout: 5000 })).toBeInTheDocument();
    // Both the assumed and measured figures are still shown.
    expect(screen.getByText('5.0 h')).toBeInTheDocument();
    expect(screen.getByText('0.0 h')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update profile' })).not.toBeInTheDocument();
  });

  it('offers the action right at the low boundary (0.05h posts to 0.1h, accepted) and posts exactly the rounded value', async () => {
    const onUpdatePrinterProfile = vi.fn();
    renderCard({ ...baseCheck, measured: 0.05 }, onUpdatePrinterProfile);

    expect(await screen.findByText('Daily usage', {}, { timeout: 5000 })).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Update profile' });
    expect(button).toBeInTheDocument();

    await userEvent.click(button);
    expect(onUpdatePrinterProfile).toHaveBeenCalledWith(1, { daily_usage_hours: 0.1 });
  });

  it('offers the action right at the high boundary (24.04h posts to 24h, accepted) and posts exactly the rounded value', async () => {
    const onUpdatePrinterProfile = vi.fn();
    renderCard({ ...baseCheck, measured: 24.04 }, onUpdatePrinterProfile);

    expect(await screen.findByText('Daily usage', {}, { timeout: 5000 })).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Update profile' });
    expect(button).toBeInTheDocument();

    await userEvent.click(button);
    expect(onUpdatePrinterProfile).toHaveBeenCalledWith(1, { daily_usage_hours: 24 });
  });

  it('withholds the action just past the high boundary (24.05h posts to 24.1h, rejected by the API) but keeps the row visible', async () => {
    renderCard({ ...baseCheck, measured: 24.05 });

    expect(await screen.findByText('Daily usage', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText('24.1 h')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update profile' })).not.toBeInTheDocument();
  });
});

describe('CalculatorRealityCheckCard: dismiss exit transition', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('marks the row as leaving and only reports the dismiss once the 150ms exit has played', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    renderCard(baseCheck, vi.fn(), onDismiss);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    const row = document.querySelector('.calc-check-row');
    expect(row).toHaveAttribute('data-leaving', 'true');
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(onDismiss).toHaveBeenCalledWith('dailyHours:all');
  });

  it('dismisses immediately under prefers-reduced-motion', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('prefers-reduced-motion'),
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const onDismiss = vi.fn();
    renderCard(baseCheck, vi.fn(), onDismiss);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledWith('dailyHours:all');
    expect(document.querySelector('.calc-check-row')).not.toHaveAttribute('data-leaving');
  });
});
