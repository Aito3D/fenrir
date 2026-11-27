import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { RevenueResult } from '../../../components/revenue/RevenueResult';
import type { ResultResponse } from '../../../components/revenue/lib/types';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const payload = (o: Partial<ResultResponse> = {}): ResultResponse => ({
  fixedMonthly: 120_000,
  charges: { labor: 0, fixed: 120_000, fixedEstimated: 0, fixedGoods: 0, depreciation: 45_000 },
  months: [
    { month: '2026-10', ht: 1_000_000, variable: 400_000, labor: 200_000, fixed: 120_000, fixedEstimated: 0, depreciation: 0, result: 280_000, resultReal: 280_000, coverage: 0.82, partial: false },
    { month: '2026-11', ht: 300_000, variable: 120_000, labor: 60_000, fixed: 150_000, fixedEstimated: 0, depreciation: 45_000, result: -30_000, resultReal: -30_000, coverage: 1, partial: false },
  ],
  costsSince: '2026-07-01',
  breakEven: { amount: 500_000, reached: 0.6, day: '2026-11-25', projected: true },
  ...o,
});
const show = (p: ResultResponse) => {
  vi.stubGlobal('fetch', vi.fn(async () => json(p)));
  render(<RevenueResult version={0} />);
};

afterEach(() => vi.unstubAllGlobals());

describe('RevenueResult', () => {
  it('shows the month result, the break-even and how far the month is', async () => {
    show(payload());
    const tile = (label: string) => screen.getByText(label).closest('div')!.parentElement!;
    expect(await screen.findByText('Result this month')).toBeInTheDocument();
    expect(within(tile('Result this month')).getByText('−30.000 FCP')).toBeInTheDocument();
    expect(within(tile('Break-even')).getByText('500.000 FCP')).toBeInTheDocument();
    expect(within(tile('Reached')).getByText('60 %')).toBeInTheDocument();
    expect(screen.getByText('expected on 25/11')).toBeInTheDocument();
  });

  it('gives depreciation its own column between fixed costs and the result', async () => {
    show(payload());
    const headers = (await screen.findAllByRole('columnheader')).map((h) => h.textContent);
    expect(headers.slice(headers.indexOf('Fixed costs'), headers.indexOf('Fixed costs') + 3)).toEqual(['Fixed costs', 'Depreciation', 'Result']);
    expect(within(screen.getAllByRole('row')[1]).getByText('45.000 FCP')).toBeInTheDocument();
  });

  it('lists every month, newest first', async () => {
    show(payload());
    const rows = (await screen.findAllByRole('row')).slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('−30.000 FCP')).toBeInTheDocument();
    expect(within(rows[1]).getByText('280.000 FCP')).toBeInTheDocument();
  });

  it('says when the break-even was crossed, or that it will not be this month', async () => {
    show(payload({ breakEven: { amount: 500_000, reached: 1.2, day: '2026-11-05', projected: false } }));
    expect(await screen.findByText('crossed on 05/11')).toBeInTheDocument();
    vi.unstubAllGlobals();
    show(payload({ breakEven: { amount: 500_000, reached: 0.1, day: null, projected: true } }));
    expect(await screen.findByText('not this month at this pace')).toBeInTheDocument();
  });

  it('gives no result for a month before costs were tracked, and says how much of the sales has a known cost', async () => {
    const p = payload();
    show({ ...p, months: [{ month: '2026-06', ht: 900_000, variable: 10_000, labor: 0, fixed: 120_000, depreciation: 0, result: 770_000, coverage: 0.1, partial: true }, ...p.months] });
    const rows = (await screen.findAllByRole('row')).slice(1);
    expect([...rows[2].children].map((c) => c.textContent)).toEqual(['juin 2026', '900.000 FCP', '—', '—', '120.000 FCP', '—', '—', '—']);
    expect(rows[1].lastElementChild).toHaveTextContent('82 %');
    expect(screen.getByText('Print and labour costs are tracked since 01/07/2026: no result before that.')).toBeInTheDocument();
  });

  it('keeps the month result when there is no break-even', async () => {
    show(payload({ breakEven: null }));
    expect(await screen.findByText('Result this month')).toBeInTheDocument();
    expect(screen.queryByText('Break-even')).toBeNull();
  });

  it('explains a missing break-even and points to the fixed costs when none is entered', async () => {
    show(payload({ breakEven: null, fixedMonthly: 0 }));
    expect(await screen.findByText('Not enough sales and costs yet to compute a break-even')).toBeInTheDocument();
    expect(screen.getByText(/No fixed cost entered yet/)).toBeInTheDocument();
  });

  it('shows the real result beside the projected one while usual charges are not entered yet', async () => {
    const p = payload();
    show({ ...p, months: [p.months[0], { ...p.months[1], fixedEstimated: 4_500, result: -42_000, resultReal: -37_500 }] });
    const tile = (label: string) => screen.getByText(label).closest('div')!.parentElement!;
    expect(await screen.findByText('Real result (Zoho)')).toBeInTheDocument();
    expect(within(tile('Real result (Zoho)')).getByText('−37.500 FCP')).toBeInTheDocument();
    expect(within(tile('Result with projection')).getByText('−42.000 FCP')).toBeInTheDocument();
    expect(screen.getByText('of which 4.500 FCP of estimated costs not entered yet')).toBeInTheDocument();
    expect(screen.queryByText('Result this month')).toBeNull();
    // The table keeps the real fixed costs and names the estimate beside them.
    const row = screen.getAllByRole('row')[1];
    expect(within(row).getByText('150.000 FCP')).toBeInTheDocument();
    expect(within(row).getByText('≈ +4.500 FCP')).toBeInTheDocument();
    expect(within(screen.getAllByRole('row')[2]).queryByText(/≈/)).toBeNull();
  });

  it('shows one result when nothing is estimated', async () => {
    show(payload());
    expect(await screen.findByText('Result this month')).toBeInTheDocument();
    expect(screen.queryByText('Real result (Zoho)')).toBeNull();
    expect(screen.queryByText(/≈/)).toBeNull();
  });
});
