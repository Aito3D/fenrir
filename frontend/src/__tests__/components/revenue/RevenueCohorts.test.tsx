import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { RevenueCohorts } from '../../../components/revenue/RevenueCohorts';
import type { CohortsResponse } from '../../../components/revenue/lib/types';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const payload = (o: Partial<CohortsResponse> = {}): CohortsResponse => ({
  cohorts: [
    { month: '2026-09', size: 8, retention: [25, 12.5, ...Array<null>(10).fill(null)], revenuePerCustomer: 42_000 },
    { month: '2026-10', size: 0, retention: Array<null>(12).fill(null), revenuePerCustomer: 0 },
  ],
  ltv: [{ segment: 'pro', customers: 31, ltv12: 310_000 }],
  atRisk: [{ customerName: 'Late SARL', lastDay: '2026-09-21', usualGapDays: 30, daysSince: 60, revenue12m: 480_000 }],
  ...o,
});
const show = (p: CohortsResponse) => {
  vi.stubGlobal('fetch', vi.fn(async () => json(p)));
  render(<RevenueCohorts version={0} />);
};

afterEach(() => vi.unstubAllGlobals());

describe('RevenueCohorts', () => {
  it('draws one row per cohort that has customers, blank where the month is still ahead', async () => {
    show(payload());
    const grid = await screen.findByRole('table', { name: 'Cohorts by first purchase' });
    const rows = within(grid).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    const cells = within(rows[0]).getAllByRole('cell');
    expect(cells.slice(0, 5).map((c) => c.textContent)).toEqual(['8', '42.000 FCP', '25 %', '13 %', '']);
    expect(cells[2]).toHaveAttribute('title', '25 % bought again in month +1');
  });

  it('gives the 12-month value per segment', async () => {
    show(payload());
    expect((await screen.findByText('Business')).closest('div')).toHaveTextContent('310.000 FCP31 customers');
  });

  it('lists the customers to chase with their rhythm', async () => {
    show(payload());
    const row = (await screen.findByText('Late SARL')).closest('tr')!;
    expect([...row.children].map((c) => c.textContent)).toEqual(['Late SARL', '21/09/2026', 'every 30 d', '60 d', '480.000 FCP']);
  });

  it('has an empty state for each part', async () => {
    show(payload({ ltv: [], atRisk: [] }));
    expect(await screen.findByText('No customer has a full year of history yet')).toBeInTheDocument();
    expect(screen.getByText('No regular customer has gone quiet')).toBeInTheDocument();
  });
});
