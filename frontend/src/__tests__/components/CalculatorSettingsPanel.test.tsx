/**
 * Tests for CalculatorSettingsPanel: the single Settings tab that replaced the
 * Defaults and Margin curve tabs — 18 fields across four sections behind one
 * Save bar that appears only while something is dirty. Carries forward the
 * former panels' pins (server-bound mirroring T-122, non-finite guard T-103,
 * permission gating T-020, live curve preview) and adds the dirty-bar and
 * changed-keys-only PATCH contract.
 */

import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useQueryClient } from '@tanstack/react-query';
import { render } from '../utils';
import { server } from '../mocks/server';
import { CalculatorSettingsPanel } from '../../components/calculator/CalculatorSettingsPanel';
import type { CalculatorDefaults } from '../../api/client';

const baseDefaults: CalculatorDefaults = {
  id: 1,
  electricity_tariff: 120,
  labor_rate_per_hour: 3000,
  consumables_packaging_flat: 30,
  failure_rate_pct: 30,
  prototype_rate_pct: 30,
  ads_rate_pct: 5,
  filament_markup_pct: 5,
  global_markup_pct: 50,
  tax_pct: 13,
  default_difficulty_pct: 100,
  default_margin_over_cost_pct: 50,
  stuff_markup_pct: 20,
  base_fee_flat: 0,
  margin_min_mult: 1.15,
  margin_max_mult: 1.6,
  margin_k: 33,
  qty_min_factor: 0.4,
  qty_k: 5,
  min_task_price: 12,
  updated_at: '2026-08-27T00:00:00Z',
};

const serveDefaults = (d: CalculatorDefaults = baseDefaults) =>
  server.use(http.get('/api/v1/calculator/defaults', () => HttpResponse.json(d)));

const saveButton = () => screen.getByRole('button', { name: 'Save settings' });

describe('CalculatorSettingsPanel', () => {
  it('renders all four sections seeded from the server, with a live curve preview', async () => {
    serveDefaults();
    render(<CalculatorSettingsPanel canUpdate />);
    expect(await screen.findByLabelText(/Electricity tariff/)).toHaveValue(120);
    expect(screen.getByLabelText(/Failure rate/)).toHaveValue(30);
    expect(screen.getByLabelText(/M_MIN/)).toHaveValue(1.15);
    expect(screen.getByLabelText(/M_MAX/)).toHaveValue(1.6);
    expect(screen.getByLabelText(/K,/)).toHaveValue(33);
    expect(screen.getByLabelText(/Q_MIN/)).toHaveValue(0.4);
    expect(screen.getByLabelText(/KQ/)).toHaveValue(5);
    expect(screen.getByLabelText(/Minimum price per task/)).toHaveValue(12);
    expect(screen.getByLabelText(/Default difficulty/)).toHaveValue(100);
    expect(screen.getByRole('heading', { name: 'Rates' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Provisions & overhead' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Margin curves' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Filament settings' })).toBeInTheDocument();
    // Preview strips: size margin at u = K is the midpoint 1.375; the
    // quantity factor at q = KQ + 1 = 6 is 0.70.
    expect(screen.getByText('×1.375')).toBeInTheDocument();
    expect(screen.getByText('0.70')).toBeInTheDocument();
    // Nothing is dirty yet, so there is no Save bar.
    expect(screen.queryByRole('button', { name: 'Save settings' })).not.toBeInTheDocument();
  });

  it('preview follows unsaved edits', async () => {
    serveDefaults();
    const user = userEvent.setup();
    render(<CalculatorSettingsPanel canUpdate />);
    const mMax = await screen.findByLabelText(/M_MAX/);
    await user.clear(mMax);
    await user.type(mMax, '2');
    // midpoint at K becomes (1.15 + 2) / 2 = 1.575
    expect(await screen.findByText('×1.575')).toBeInTheDocument();
  });

  it('shows the Save bar with a change count once a field is dirty, and Discard clears it', async () => {
    serveDefaults();
    const user = userEvent.setup();
    render(<CalculatorSettingsPanel canUpdate />);
    const tariff = await screen.findByLabelText(/Electricity tariff/);
    await user.clear(tariff);
    await user.type(tariff, '150');
    expect(await screen.findByText('1 unsaved change')).toBeInTheDocument();
    const tax = screen.getByLabelText(/Tax/);
    await user.clear(tax);
    await user.type(tax, '11');
    expect(await screen.findByText('2 unsaved changes')).toBeInTheDocument();
    // Retyping the original value is no longer a change.
    await user.clear(tax);
    await user.type(tax, '13');
    expect(await screen.findByText('1 unsaved change')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Discard' }));
    // The bar stays mounted so it can slide back out; closed, it is
    // aria-hidden and its controls leave the accessibility tree.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument());
    expect(tariff).toHaveValue(120);
  });

  it('PATCHes only the changed keys, toasts, and hides the bar again', async () => {
    let sent: Record<string, number> | null = null;
    // The GET echoes the saved row, as the real server does — the post-save
    // refetch must not roll the form back.
    let row: CalculatorDefaults = { ...baseDefaults };
    server.use(
      http.get('/api/v1/calculator/defaults', () => HttpResponse.json(row)),
      http.patch('/api/v1/calculator/defaults', async ({ request }) => {
        sent = (await request.json()) as Record<string, number>;
        row = { ...row, ...sent, updated_at: '2026-08-28T00:00:00Z' };
        return HttpResponse.json(row);
      }),
    );
    const user = userEvent.setup();
    render(<CalculatorSettingsPanel canUpdate />);
    const k = await screen.findByLabelText(/K,/);
    await user.clear(k);
    await user.type(k, '4000');
    const tariff = screen.getByLabelText(/Electricity tariff/);
    await user.clear(tariff);
    await user.type(tariff, '150');
    await user.click(saveButton());
    await waitFor(() => expect(sent).not.toBeNull());
    expect(sent).toEqual({ electricity_tariff: 150, margin_k: 4000 });
    expect(await screen.findByText('Settings saved')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save settings' })).not.toBeInTheDocument());
    // The saved values are the new baseline.
    expect(k).toHaveValue(4000);
  });

  it('blocks save when M_MAX < M_MIN and names the problem in the bar', async () => {
    serveDefaults();
    const user = userEvent.setup();
    render(<CalculatorSettingsPanel canUpdate />);
    const mMax = await screen.findByLabelText(/M_MAX/);
    await user.clear(mMax);
    await user.type(mMax, '1.1');
    expect(await screen.findByText('M_MAX must be at least M_MIN')).toBeInTheDocument();
    expect(screen.getByText('Fix the highlighted fields to save.')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it('marks an out-of-range field inline and disables Save without discarding another edit (T-122)', async () => {
    serveDefaults();
    const user = userEvent.setup();
    render(<CalculatorSettingsPanel canUpdate />);
    const tariff = await screen.findByLabelText(/Electricity tariff/, {}, { timeout: 5000 });
    await user.clear(tariff);
    await user.type(tariff, '150');
    const tax = screen.getByLabelText(/Tax/);
    await user.clear(tax);
    await user.type(tax, '150');
    expect(await screen.findByText('Must be between 0 and 100')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    expect(tariff).toHaveValue(150);

    await user.clear(tax);
    await user.type(tax, '15');
    await waitFor(() => expect(screen.queryByText('Must be between 0 and 100')).not.toBeInTheDocument());
    expect(saveButton()).toBeEnabled();
  });

  it('rejects default_difficulty_pct below its 100 floor, naming the real bound (T-122)', async () => {
    serveDefaults();
    const user = userEvent.setup();
    render(<CalculatorSettingsPanel canUpdate />);
    const difficulty = await screen.findByLabelText(/Default difficulty/, {}, { timeout: 5000 });
    await user.clear(difficulty);
    await user.type(difficulty, '50');
    expect(await screen.findByText('Must be between 100 and 1000')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  // Transcribed from CalculatorDefaultsUpdate's Field(...) bounds
  // (backend/app/schemas/calculator.py). The panel's own copy is
  // module-private, so this pins the mirror behaviorally: drive each input
  // one past its bound and confirm the panel names the right numbers and
  // refuses to submit, then confirm the bound itself is accepted.
  const MONEY_CEILING = 100_000_000;
  const bounds: Array<{ id: string; min: number; max: number }> = [
    { id: 'calc-def-electricity_tariff', min: 0, max: MONEY_CEILING },
    { id: 'calc-def-labor_rate_per_hour', min: 0, max: MONEY_CEILING },
    { id: 'calc-def-consumables_packaging_flat', min: 0, max: MONEY_CEILING },
    { id: 'calc-def-base_fee_flat', min: 0, max: MONEY_CEILING },
    { id: 'calc-def-tax_pct', min: 0, max: 100 },
    { id: 'calc-def-failure_rate_pct', min: 0, max: 1000 },
    { id: 'calc-def-prototype_rate_pct', min: 0, max: 1000 },
    { id: 'calc-def-ads_rate_pct', min: 0, max: 1000 },
    { id: 'calc-def-filament_markup_pct', min: 0, max: 1000 },
    { id: 'calc-def-stuff_markup_pct', min: 0, max: 1000 },
    { id: 'calc-curve-margin_min_mult', min: 1, max: 100 },
    { id: 'calc-curve-margin_max_mult', min: 1, max: 100 },
    { id: 'calc-curve-margin_k', min: 0, max: MONEY_CEILING },
    { id: 'calc-curve-qty_min_factor', min: 0, max: 1 },
    { id: 'calc-curve-qty_k', min: 0, max: 1_000_000 },
    { id: 'calc-curve-min_task_price', min: 0, max: MONEY_CEILING },
    { id: 'calc-def-default_difficulty_pct', min: 100, max: 1000 },
    { id: 'calc-def-default_margin_over_cost_pct', min: 0, max: 1000 },
  ];

  it.each(bounds)('$id rejects $max + 1 and accepts $max', async ({ id, min, max }) => {
    serveDefaults();
    const user = userEvent.setup();
    const { container } = render(<CalculatorSettingsPanel canUpdate />);
    await screen.findByLabelText(/Electricity tariff/, {}, { timeout: 5000 });
    const input = container.querySelector<HTMLInputElement>(`#${id}`);
    expect(input, `no rendered input for ${id}`).not.toBeNull();
    if (!input) return;

    await user.clear(input);
    await user.type(input, String(max + 1));
    expect(await screen.findByText(`Must be between ${min} and ${max}`)).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();

    await user.clear(input);
    await user.type(input, String(max));
    await waitFor(() => expect(screen.queryByText(`Must be between ${min} and ${max}`)).not.toBeInTheDocument());
    // Every other field in baseDefaults is in range, so fixing the last
    // offender re-enables Save — except M_MIN at its ceiling, which now
    // exceeds M_MAX (1.6) and trips the pair rule instead.
    if (id === 'calc-curve-margin_min_mult') {
      expect(await screen.findByText('M_MAX must be at least M_MIN')).toBeInTheDocument();
      expect(saveButton()).toBeDisabled();
    } else {
      await waitFor(() => expect(saveButton()).toBeEnabled());
    }
  });

  // A corrupted row can seed the form with a non-finite string without any
  // DOM typing involved (JSON `1e400` parses to Infinity) — see the T-103
  // note in the former Defaults panel tests. The gate must still hold.
  it('disables Save when the loaded row holds a value that resolves to Infinity (T-103)', async () => {
    const rawBody = JSON.stringify(baseDefaults).replace('"electricity_tariff":120', '"electricity_tariff":1e400');
    server.use(
      http.get('/api/v1/calculator/defaults', () => new HttpResponse(rawBody, { headers: { 'Content-Type': 'application/json' } })),
    );
    const user = userEvent.setup();
    render(<CalculatorSettingsPanel canUpdate />);
    expect(await screen.findByLabelText(/Labor rate/)).toHaveValue(3000);
    // Dirty another field so the bar (and its Save) exists to be judged.
    const labor = screen.getByLabelText(/Labor rate/);
    await user.clear(labor);
    await user.type(labor, '3100');
    expect(await screen.findByRole('button', { name: 'Save settings' })).toBeDisabled();
  });

  it('never shows the Save bar without calculator:update, and a raw submit does not PATCH (T-020)', async () => {
    let patchCalled = false;
    server.use(
      http.get('/api/v1/calculator/defaults', () => HttpResponse.json(baseDefaults)),
      http.patch('/api/v1/calculator/defaults', () => {
        patchCalled = true;
        return HttpResponse.json(baseDefaults);
      }),
    );
    const user = userEvent.setup();
    const { container } = render(<CalculatorSettingsPanel canUpdate={false} />);
    const tariff = await screen.findByLabelText(/Electricity tariff/);
    expect(tariff).toHaveValue(120);
    await user.clear(tariff);
    await user.type(tariff, '150');
    expect(screen.queryByRole('button', { name: 'Save settings' })).not.toBeInTheDocument();

    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(patchCalled).toBe(false);
  });

  it('follows a background refetch while untouched, but keeps in-progress edits once dirty (T-031)', async () => {
    let row = { ...baseDefaults };
    server.use(http.get('/api/v1/calculator/defaults', () => HttpResponse.json(row)));
    const user = userEvent.setup();
    render(
      <>
        <CalculatorSettingsPanel canUpdate />
        <InvalidateDefaultsButton />
      </>,
    );
    const labor = await screen.findByLabelText(/Labor rate/);
    expect(labor).toHaveValue(3000);

    // Untouched: another session's save flows into the form.
    row = { ...row, labor_rate_per_hour: 3500, updated_at: '2026-08-28T00:00:00Z' };
    await user.click(screen.getByRole('button', { name: 'simulate background refetch' }));
    await waitFor(() => expect(labor).toHaveValue(3500));

    // Dirty: a refetch must not overwrite the typing.
    const tariff = screen.getByLabelText(/Electricity tariff/);
    await user.clear(tariff);
    await user.type(tariff, '150');
    row = { ...row, electricity_tariff: 999, updated_at: '2026-08-28T00:01:00Z' };
    await user.click(screen.getByRole('button', { name: 'simulate background refetch' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tariff).toHaveValue(150);
    expect(await screen.findByText('1 unsaved change')).toBeInTheDocument();
  });

  it('plots an example job on both curves and reads out the multipliers', async () => {
    serveDefaults();
    const user = userEvent.setup();
    render(<CalculatorSettingsPanel canUpdate />);
    // Defaults: K = 33 → example unit cost seeds to 33, quantity 1.
    const cost = await screen.findByLabelText(/Example unit cost/);
    expect(cost).toHaveValue(33);
    expect(screen.getByLabelText(/Example quantity/)).toHaveValue(1);
    // sizeMargin(33) with M 1.15/1.6, K 33 = 1.375; qty factor at 1 = 1.
    expect(screen.getByText('×1.375 size margin · ×1.000 quantity factor → ×1.375 on cost')).toBeInTheDocument();
    await user.clear(cost);
    await user.type(cost, '330');
    // sizeMargin(330) = 1.15 + 0.45 × 33/363 = 1.1909
    expect(await screen.findByText(/×1\.191 size margin/)).toBeInTheDocument();
    // Editing the example never dirties the form.
    expect(screen.queryByRole('button', { name: 'Save settings' })).not.toBeInTheDocument();
  });
});

// Stands in for a background refetch of ['calculatorDefaults'] triggered
// elsewhere (another session's save, another tab, a reality-check apply) —
// invalidating the query without the form itself doing anything.
function InvalidateDefaultsButton() {
  const queryClient = useQueryClient();
  return (
    <button type="button" onClick={() => queryClient.invalidateQueries({ queryKey: ['calculatorDefaults'] })}>
      simulate background refetch
    </button>
  );
}
