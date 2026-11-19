import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { RevenueTable } from '../../../components/revenue/RevenueTable';
import type { RevenueBucket, RevenueItemRow } from '../../../components/revenue/lib/types';
import { bucket } from './lib/fixtures';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const sept = bucket({ key: '2026-09', label: 'sept. 2026', start: '2026-09-01', end: '2026-09-30', ht: 500_000, ttc: 565_000, quantity: 40, cost: 300_000, costedHt: 500_000 });
const oct = bucket({
  ht: 620_000,
  ttc: 700_600,
  quantity: 52,
  cost: 434_000,
  costedHt: 620_000,
  partial: true,
  missingDays: 3,
  ttcApprox: true,
  elapsedDays: 15,
  evolution: { ht: 0.24, ttc: 0.24 },
});

const item = (o: Partial<RevenueItemRow> = {}): RevenueItemRow => ({
  itemId: 'i1',
  name: 'PLA Basic 1 kg',
  sku: 'PLA-1',
  quantity: 4,
  ht: 40_000,
  ttc: 45_200,
  cost: 26_000,
  nature: 'Filament',
  brand: 'Bambu',
  kind: 'goods',
  reason: 'brand',
  ...o,
});

function stubItems(items: RevenueItemRow[]) {
  const fetchMock = vi.fn(async () => json({ items, from: '2026-10-01', to: '2026-10-31' }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const renderTable = (o: { buckets?: RevenueBucket[]; canMargin?: boolean; filterParams?: string; version?: unknown } = {}) => (
  <RevenueTable buckets={o.buckets ?? [sept, oct]} granularity="month" taxMode="ht" canMargin={o.canMargin ?? true} filterParams={o.filterParams ?? ''} version={o.version ?? 0} />
);

const bodyRows = () => screen.getAllByRole('row').filter((r) => within(r).queryAllByRole('columnheader').length === 0);

afterEach(() => vi.unstubAllGlobals());

describe('RevenueTable', () => {
  it('lists the periods newest first under named columns', () => {
    render(renderTable());
    expect(screen.getByRole('table', { name: 'Detail by period' })).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Period', 'Revenue HT', 'Revenue TTC', 'Change', 'Margin', 'Units']);
    const rows = bodyRows();
    expect(rows[0]).toHaveTextContent('oct. 2026');
    expect(rows[1]).toHaveTextContent('sept. 2026');
    expect(within(rows[0]).getByText('620.000 FCP')).toBeInTheDocument();
    expect(within(rows[0]).getByText('▲ 24%')).toBeInTheDocument();
    expect(within(rows[0]).getByText('52')).toBeInTheDocument();
  });

  it('marks an approximate TTC with ≈', () => {
    render(renderTable());
    const [octRow, septRow] = bodyRows();
    expect(within(octRow).getByText('700.600 FCP ≈')).toBeInTheDocument();
    expect(within(septRow).getByText('565.000 FCP')).toBeInTheDocument();
  });

  it('badges the bucket in progress and its missing days', () => {
    render(renderTable());
    const [octRow, septRow] = bodyRows();
    expect(within(octRow).getByText('in progress')).toBeInTheDocument();
    expect(within(octRow).getByText('Missing days: 3')).toBeInTheDocument();
    expect(within(septRow).queryByText('in progress')).toBeNull();
    expect(within(septRow).queryByText(/Missing days/)).toBeNull();
  });

  it('shows the margin rate only with view_margin and cost fields', () => {
    const { unmount } = render(renderTable());
    expect(within(bodyRows()[0]).getByText('30 %')).toBeInTheDocument();
    unmount();
    const r2 = render(renderTable({ canMargin: false }));
    expect(screen.queryByRole('columnheader', { name: 'Margin' })).toBeNull();
    r2.unmount();
    const strip = ({ cost: _c, costedHt: _h, ...b }: RevenueBucket) => b as RevenueBucket;
    render(renderTable({ buckets: [strip(sept), strip(oct)] }));
    expect(screen.queryByRole('columnheader', { name: 'Margin' })).toBeNull();
  });

  it('expands a row into its items, fetched with the page filters', async () => {
    const fetchMock = stubItems([item(), item({ itemId: 'i2', name: 'Printing service', sku: '', kind: 'service', quantity: 1, ht: 10_000, ttc: 11_300, cost: null })]);
    render(renderTable({ filterParams: '&brand=bambu&kind=goods' }));
    const toggle = screen.getByRole('button', { name: /oct\. 2026/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(await screen.findByText('PLA Basic 1 kg')).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/revenue/items?from=2026-10-01&to=2026-10-31&brand=bambu&kind=goods');
    expect(screen.getByText('40.000 FCP')).toBeInTheDocument();
    expect(screen.getByText('35 %')).toBeInTheDocument();
    expect(screen.getByText('Printing service')).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('PLA Basic 1 kg')).toBeNull();
  });

  it('says so when a period has no item', async () => {
    stubItems([]);
    render(renderTable());
    fireEvent.click(screen.getByRole('button', { name: /sept\. 2026/ }));
    expect(await screen.findByText('No Aito3D sales in this period.')).toBeInTheDocument();
  });

  it('refetches an open row when the data version changes', async () => {
    const fetchMock = stubItems([item()]);
    const { rerender } = render(renderTable({ version: 1 }));
    fireEvent.click(screen.getByRole('button', { name: /oct\. 2026/ }));
    await screen.findByText('PLA Basic 1 kg');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender(renderTable({ version: 2 }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
