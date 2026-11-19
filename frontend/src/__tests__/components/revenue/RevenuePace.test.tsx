import type { ComponentProps } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { RevenuePace } from '../../../components/revenue/RevenuePace';
import type { CalendarDay, TaxMode } from '../../../components/revenue/lib/types';

// jsdom has no layout, so ResponsiveContainer renders nothing; pin a size.
vi.mock('recharts', async (orig) => {
  const actual = await orig<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: (props: ComponentProps<typeof actual.ResponsiveContainer>) => (
      <actual.ResponsiveContainer {...props} width={800} height={300} />
    ),
  };
});

const day = (d: string, ht: number): CalendarDay => ({ day: d, ht, ttc: Math.round(ht * 1.13), fetched: true });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

function stubFetch(days: { current: CalendarDay[]; previous: CalendarDay[] }) {
  const fetchMock = vi.fn(async (u: string) => {
    if (u.startsWith('/api/v1/revenue/targets')) return json({ targets: [{ month: '2026-11', amountHt: 3_000_000, updatedAt: '2026-11-01T00:00:00Z' }] });
    if (u.includes('from=2026-11-01')) return json({ from: '2026-11-01', to: '2026-11-30', days: days.current });
    return json({ from: '2025-11-01', to: '2025-11-30', days: days.previous });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const renderPace = (o: { taxMode?: TaxMode; filterParams?: string } = {}) =>
  render(<RevenuePace monthKey="2026-11" filterParams={o.filterParams ?? ''} taxMode={o.taxMode ?? 'ht'} version={0} />);

const someDays = { current: [day('2026-11-01', 100_000), day('2026-11-02', 50_000)], previous: [day('2025-11-01', 80_000), day('2025-11-02', 90_000)] };

afterEach(() => vi.unstubAllGlobals());

describe('RevenuePace', () => {
  it('reads this month and the same month a year earlier with the filters', async () => {
    const fetchMock = stubFetch(someDays);
    renderPace({ filterParams: '&brand=esun' });
    await waitFor(() => expect(screen.getByText('Pace · nov. 2026')).toBeInTheDocument());
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toContain('/api/v1/revenue/daily?from=2026-11-01&to=2026-11-30&brand=esun');
    expect(urls).toContain('/api/v1/revenue/daily?from=2025-11-01&to=2025-11-30&brand=esun');
    expect(screen.getByText('This month')).toBeInTheDocument();
    expect(screen.getByText('2025')).toBeInTheDocument();
  });

  it('names the year-ago month total in the legend once the whole month is known', async () => {
    const full = Array.from({ length: 30 }, (_, i) => day(`2025-11-${String(i + 1).padStart(2, '0')}`, 10_000));
    stubFetch({ current: someDays.current, previous: full });
    renderPace();
    expect(await screen.findByText('2025 · total 300.000 FCP')).toBeInTheDocument();
  });

  it('sums up both running totals to date', async () => {
    stubFetch(someDays);
    renderPace();
    const line = await screen.findByText('Day 2: 150.000 FCP vs 170.000 FCP last year');
    expect(line).toHaveClass('tabular-nums');
    expect(screen.getByText('▼ 12%')).toBeInTheDocument();
  });

  it('sums up this month alone without a year-ago value', async () => {
    stubFetch({ current: someDays.current, previous: [] });
    renderPace();
    expect(await screen.findByText('Day 2: 150.000 FCP')).toBeInTheDocument();
  });

  it('keeps only the days that start with the month key', async () => {
    // A clamped answer for another month must not read as this month's 1st.
    stubFetch({ current: [day('2026-10-01', 100_000)], previous: someDays.previous });
    renderPace();
    expect(await screen.findByText('No sales yet this month.')).toBeInTheDocument();
  });

  it('draws the dashed target line in HT on the whole book', async () => {
    stubFetch(someDays);
    const { container } = renderPace();
    expect(await screen.findByText('Target')).toBeInTheDocument();
    await waitFor(() => expect(container.querySelector('.recharts-line path[stroke="#f59e0b"]')).not.toBeNull());
    expect(container.querySelector('.recharts-line path[stroke="#f59e0b"]')).toHaveAttribute('stroke-dasharray', '5 4');
  });

  it('drops the target line in TTC', async () => {
    stubFetch(someDays);
    const { container } = renderPace({ taxMode: 'ttc' });
    await screen.findByText('This month');
    await waitFor(() => expect(container.querySelector('.recharts-line path')).not.toBeNull());
    expect(screen.queryByText('Target')).toBeNull();
    expect(container.querySelector('.recharts-line path[stroke="#f59e0b"]')).toBeNull();
  });

  it('drops the target line when a filter is active', async () => {
    stubFetch(someDays);
    const { container } = renderPace({ filterParams: '&kind=goods' });
    await screen.findByText('This month');
    await waitFor(() => expect(container.querySelector('.recharts-line path')).not.toBeNull());
    expect(screen.queryByText('Target')).toBeNull();
  });

  it('says so when the month has no sale yet', async () => {
    stubFetch({ current: [], previous: someDays.previous });
    renderPace();
    expect(await screen.findByText('No sales yet this month.')).toBeInTheDocument();
  });
});
