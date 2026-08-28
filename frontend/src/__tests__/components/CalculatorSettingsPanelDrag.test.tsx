/**
 * Drag-to-set K coverage for CalculatorSettingsPanel, split out of
 * CalculatorSettingsPanel.test.tsx: recharts' `ResponsiveContainer` reports
 * zero width in jsdom, so `useOffset()` inside `DragHandle` returns
 * `width: 0` and the handle renders null there — the main suite's 29 tests
 * never touch chart geometry, so they pass either way, but a real drag grip
 * needs `useOffset` mocked to a non-zero plot rect. Isolated here so that
 * mock doesn't leak into the rest of the settings-panel suite.
 */

import type { ComponentProps } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { render } from '../utils';
import { server } from '../mocks/server';
import { http, HttpResponse } from 'msw';
import { CalculatorSettingsPanel } from '../../components/calculator/CalculatorSettingsPanel';
import type { CalculatorDefaults } from '../../api/client';

// recharts' `ResponsiveContainer` measures its DOM node via
// `getBoundingClientRect`/`ResizeObserver`, both of which report 0 in jsdom
// (the global `ResizeObserverMock` in setup.ts never fires a callback). With
// a 0×0 measured size recharts renders nothing at all inside the chart's
// `<svg>` — not even `CartesianGrid`/`XAxis` — so mocking `useOffset` alone
// (as the isolated `DragHandle.test.tsx` does, where `DragHandle` is
// rendered directly with no `ResponsiveContainer` in the tree) does not
// make the grip mount here: confirmed experimentally, the `<svg>` stayed
// empty. Overriding just `ResponsiveContainer` to substitute a fixed pixel
// width for the `width="100%"` MarginCurvePreview passes it lets recharts'
// real layout/measurement machinery run end to end, so `useOffset` (left
// unmocked here) returns genuine numbers and the grip renders where the
// real geometry puts it.
vi.mock('recharts', async (orig) => {
  const actual = await orig<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: (props: ComponentProps<typeof actual.ResponsiveContainer>) => (
      <actual.ResponsiveContainer {...props} width={600} />
    ),
  };
});

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

describe('CalculatorSettingsPanel — drag handles', () => {
  it('dragging K writes the field and opens the Save bar', async () => {
    serveDefaults();
    render(<CalculatorSettingsPanel canUpdate />);
    const grip = await screen.findByRole('button', { name: 'Drag to set K' });
    fireEvent.keyDown(grip, { key: 'ArrowRight', shiftKey: true }); // +10 % of 0..330 = 33
    expect(screen.getByLabelText(/K,/)).toHaveValue(66);
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeInTheDocument();
  });

  it('read-only viewers get no drag grips', async () => {
    serveDefaults();
    render(<CalculatorSettingsPanel canUpdate={false} />);
    await screen.findByLabelText(/K,/);
    expect(screen.queryByRole('button', { name: /Drag to set/ })).not.toBeInTheDocument();
  });
});
