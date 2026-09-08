/**
 * Pins a real defect fixed in this branch: breakEvenDiscount now returns
 * null both when there is no price yet AND when the job is already selling
 * below cost at 0% discount (see pricing.ts). CalculatorDiscountTable's
 * `belowCost` helper used to read `breakEven !== null && ...`, so the null
 * return for an underwater job made every column — and the red <th>
 * headers — silently stop being tinted, which is the exact case the
 * operator most needs the warning. This test fails against that one-liner.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { CalculatorDiscountTable } from '../../../components/calculator/CalculatorDiscountTable';
import {
  breakEvenDiscount,
  computePricing,
  type PricingDefaults,
  type PricingFilament,
  type PricingInputs,
  type PricingPrinter,
} from '../../../utils/pricing';

// A filament whose sale_price_per_kg is backfilled below its cost_per_kg —
// reachable via CalculatorFilamentBase (backend/app/schemas/calculator.py),
// which has no ge=cost_per_kg constraint on sale_price_per_kg. Everything
// else is zeroed out so the only margin line is margin_filament, and it is
// negative enough to drag total_ht below total_cost even after the (here
// disabled) per-task floor.
const underwaterFilament: PricingFilament = { cost_per_kg: 1000, sale_price_per_kg: 10, difficulty_pct: 100 };
const flatPrinter: PricingPrinter = { purchase_price: 0, lifetime_years: 1, daily_usage_hours: 1, power_watts: 0, repair_rate_pct: 0 };
const noOverheadDefaults: PricingDefaults = {
  electricity_tariff: 0,
  labor_rate_per_hour: 0,
  consumables_packaging_flat: 0,
  failure_rate_pct: 0,
  prototype_rate_pct: 0,
  ads_rate_pct: 0,
  filament_markup_pct: 0,
  global_markup_pct: 0,
  tax_pct: 0,
  default_difficulty_pct: 100,
  stuff_markup_pct: 0,
  min_task_price: 0, // disable the floor so it can't mask the underwater price
};
const underwaterInputs: PricingInputs = {
  weight_g: 1000,
  printing_time_h: 0,
  quantity: 1,
  modeling_hours: 0,
  modeling_base_price: 0,
  prep_model_min: 0,
  prep_slicing_min: 0,
  prep_transfer_min: 0,
  post_removal_min: 0,
  post_support_min: 0,
  post_additional_min: 0,
  post_fulfillment_min: 0,
  stuff_amount: 0,
  stuff_markup_pct: 0,
};

describe('CalculatorDiscountTable', () => {
  it('still tints every column red when the job is underwater at 0% discount (breakEvenDiscount is null)', () => {
    const result = computePricing(underwaterInputs, underwaterFilament, flatPrinter, noOverheadDefaults);
    // Sanity: this is exactly the null-because-underwater branch, not the
    // null-because-no-price branch.
    expect(breakEvenDiscount(result)).toBeNull();
    expect(result.total_cost).toBeGreaterThan(result.total_ht);

    render(<CalculatorDiscountTable result={result} currency="USD" easy={false} />);

    // Every discount-percent header (skip the leading blank label header)
    // must carry the red text class.
    const headers = screen.getAllByRole('columnheader').slice(1);
    expect(headers.length).toBeGreaterThan(0);
    for (const h of headers) {
      expect(h.className).toContain('text-status-error');
    }

    // The price row's cells must all carry the red tint background too
    // (skip the leading sticky row-label cell, which is not a discount
    // column and never tinted).
    const priceRow = screen.getByText('Price w/ discount').closest('tr')!;
    const priceCells = within(priceRow).getAllByRole('cell').slice(1);
    expect(priceCells.length).toBeGreaterThan(0);
    for (const c of priceCells) {
      expect(c.className).toContain('bg-status-error/5');
    }

    // Machine-cost row too.
    const machineRow = screen.getByText('Machine cost w/ discount').closest('tr')!;
    const machineCells = within(machineRow).getAllByRole('cell').slice(1);
    for (const c of machineCells) {
      expect(c.className).toContain('bg-status-error/5');
    }
  });
});
