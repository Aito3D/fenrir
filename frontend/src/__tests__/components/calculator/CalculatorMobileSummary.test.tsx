/**
 * T-052: the sticky mobile summary bar (below-xl layout) had no
 * characterization test. `useBelowXl()` reads `window.matchMedia('(max-width:
 * 1279px)')` and only renders content once `.matches` is true — every prior
 * Calculator test left that unstubbed, so `matches` defaulted to `false` and
 * lines 28-45 (the TTC total, margin-pct badge, per-unit label) were never
 * exercised.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils';
import { CalculatorMobileSummary } from '../../../components/calculator/CalculatorMobileSummary';
import type { PricingResult } from '../../../utils/pricing';

const baseResult: PricingResult = {
  filament_cost: 0,
  depreciation_cost: 0,
  energy_cost: 0,
  repairs_cost: 0,
  machine_cost: 0,
  prototype_cost: 0,
  failures_cost: 0,
  machine_cost_safety: 0,
  ads_cost: 0,
  consumables_flat: 0,
  base_fee_total: 0,
  base_fee: 0,
  modeling_cost_total: 0,
  prep_cost_total: 0,
  modeling_cost: 0,
  prep_cost: 0,
  post_processing_cost: 0,
  stuff_cost: 0,
  labor_total: 0,
  risk_base: 0,
  total_cost: 0,
  margin_global: 0,
  size_margin: 1,
  qty_factor: 1,
  margin_multiplier: 1,
  floor_applied: false,
  margin_filament: 0,
  margin_stuff: 0,
  marge: 0,
  total_ht: 0,
  total_ttc: 42.5,
  margin_pct: 0.3333,
  quantity: 1,
  total_ht_qty: 0,
  total_ttc_qty: 0,
};

/** Stubs `window.matchMedia` so `useBelowXl()`'s exact query string
 *  resolves to `matches`, with inert (change) listener wiring. */
function stubBelowXl(matches: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 1279px)' && matches,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

describe('CalculatorMobileSummary (T-052)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders nothing above the xl breakpoint (matchMedia reports no match)', () => {
    stubBelowXl(false);
    render(<CalculatorMobileSummary result={baseResult} currency="USD" />);
    expect(screen.queryByText('Total incl. tax')).not.toBeInTheDocument();
    expect(screen.queryByText('33.33%')).not.toBeInTheDocument();
  });

  it('renders the sticky bar with the TTC total and margin badge below the xl breakpoint', () => {
    stubBelowXl(true);
    render(<CalculatorMobileSummary result={baseResult} currency="USD" />);

    expect(screen.getByText('Total incl. tax')).toBeInTheDocument();
    expect(screen.getByText('$42.50')).toBeInTheDocument();
    expect(screen.getByText('33.33%')).toBeInTheDocument();
    expect(screen.queryByText('per unit', { exact: false })).not.toBeInTheDocument();
  });

  it('appends the per-unit label when quantity is greater than 1', () => {
    stubBelowXl(true);
    render(<CalculatorMobileSummary result={{ ...baseResult, quantity: 3 }} currency="USD" />);

    expect(screen.getByText('Total incl. tax · per unit')).toBeInTheDocument();
  });
});
