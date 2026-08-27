/**
 * Tests for CalculatorMarginCurvePanel: the margin-curve settings tab
 * (size-margin × quantity-discount model in utils/pricing.ts) plus the task
 * floor. Mirrors the setup of CalculatorSettingsPanels.test.tsx (same
 * render/server helpers) but lives in its own file since this panel is
 * exercised directly, not alongside the other settings panels.
 */

import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { CalculatorMarginCurvePanel } from '../../components/calculator/CalculatorMarginCurvePanel';
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

describe('CalculatorMarginCurvePanel', () => {
  it('renders the six fields seeded from the server and a live preview', async () => {
    server.use(http.get('/api/v1/calculator/defaults', () => HttpResponse.json(baseDefaults)));
    render(<CalculatorMarginCurvePanel canUpdate />);
    expect(await screen.findByLabelText(/M_MIN/)).toHaveValue(1.15);
    expect(screen.getByLabelText(/M_MAX/)).toHaveValue(1.6);
    expect(screen.getByLabelText(/K,/)).toHaveValue(33);
    expect(screen.getByLabelText(/Q_MIN/)).toHaveValue(0.4);
    expect(screen.getByLabelText(/KQ/)).toHaveValue(5);
    expect(screen.getByLabelText(/Minimum price per task/)).toHaveValue(12);
    // Preview strip: at u = K the size margin is the midpoint 1.375
    expect(screen.getByText('×1.375')).toBeInTheDocument();
    // and at q = KQ + 1 = 6 the quantity factor is 0.70
    expect(screen.getByText('0.70')).toBeInTheDocument();
  });

  it('preview follows unsaved edits', async () => {
    server.use(http.get('/api/v1/calculator/defaults', () => HttpResponse.json(baseDefaults)));
    const user = userEvent.setup();
    render(<CalculatorMarginCurvePanel canUpdate />);
    const mMax = await screen.findByLabelText(/M_MAX/);
    await user.clear(mMax);
    await user.type(mMax, '2');
    // midpoint at K becomes (1.15 + 2) / 2 = 1.575
    expect(await screen.findByText('×1.575')).toBeInTheDocument();
  });

  it('blocks save when M_MAX < M_MIN and names the problem', async () => {
    server.use(http.get('/api/v1/calculator/defaults', () => HttpResponse.json(baseDefaults)));
    const user = userEvent.setup();
    render(<CalculatorMarginCurvePanel canUpdate />);
    const mMax = await screen.findByLabelText(/M_MAX/);
    await user.clear(mMax);
    await user.type(mMax, '1.1');
    expect(await screen.findByText('M_MAX must be at least M_MIN')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save margin curve' })).toBeDisabled();
  });

  it.each([
    { key: 'margin_min_mult', min: 1, max: 100 },
    { key: 'margin_max_mult', min: 1, max: 100 },
    { key: 'margin_k', min: 0, max: 100_000_000 },
    { key: 'qty_min_factor', min: 0, max: 1 },
    { key: 'qty_k', min: 0, max: 1_000_000 },
    { key: 'min_task_price', min: 0, max: 100_000_000 },
  ])('$key rejects $max + 1', async ({ key, min, max }) => {
    server.use(http.get('/api/v1/calculator/defaults', () => HttpResponse.json(baseDefaults)));
    const user = userEvent.setup();
    const { container } = render(<CalculatorMarginCurvePanel canUpdate />);
    await screen.findByLabelText(/M_MIN/);
    const input = container.querySelector<HTMLInputElement>(`#calc-curve-${key}`)!;
    await user.clear(input);
    await user.type(input, String(max + 1));
    expect(await screen.findByText(`Must be between ${min} and ${max}`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save margin curve' })).toBeDisabled();
  });

  it('PATCHes only the six curve fields and toasts', async () => {
    let sent: Record<string, number> | null = null;
    server.use(
      http.get('/api/v1/calculator/defaults', () => HttpResponse.json(baseDefaults)),
      http.patch('/api/v1/calculator/defaults', async ({ request }) => {
        sent = (await request.json()) as Record<string, number>;
        return HttpResponse.json({ ...baseDefaults, ...sent });
      }),
    );
    const user = userEvent.setup();
    render(<CalculatorMarginCurvePanel canUpdate />);
    const k = await screen.findByLabelText(/K,/);
    await user.clear(k);
    await user.type(k, '4000');
    await user.click(screen.getByRole('button', { name: 'Save margin curve' }));
    await waitFor(() => expect(sent).not.toBeNull());
    expect(Object.keys(sent!).sort()).toEqual(
      ['margin_k', 'margin_max_mult', 'margin_min_mult', 'min_task_price', 'qty_k', 'qty_min_factor'],
    );
    expect(sent!.margin_k).toBe(4000);
    expect(await screen.findByText('Margin curve saved')).toBeInTheDocument();
  });

  it('hides Save without update permission', async () => {
    server.use(http.get('/api/v1/calculator/defaults', () => HttpResponse.json(baseDefaults)));
    render(<CalculatorMarginCurvePanel canUpdate={false} />);
    await screen.findByLabelText(/M_MIN/);
    expect(screen.queryByRole('button', { name: 'Save margin curve' })).not.toBeInTheDocument();
  });
});
