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
  yearAgo: { ht: 400_000, ttc: 452_000 },
  cumulative: { ht: 1_120_000, ttc: 1_265_600 },
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
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Period', 'Revenue HT', 'Revenue TTC', 'Change', 'Over a year', 'Margin', 'Running total', 'Units']);
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

  it('shows the year-over-year change and the running total, both marked to date on a partial bucket', () => {
    render(renderTable());
    const [octRow, septRow] = bodyRows();
    const cells = within(octRow).getAllByRole('cell');
    expect(within(cells[4]).getByText('▲ 55%')).toBeInTheDocument();
    expect(within(cells[3]).getByText('to date')).toBeInTheDocument();
    expect(within(cells[4]).getByText('to date')).toBeInTheDocument();
    expect(within(cells[6]).getByText('1.120.000 FCP')).toBeInTheDocument();
    expect(within(septRow).getAllByRole('cell')[4]).toHaveTextContent('—');
    expect(within(septRow).queryByText('to date')).toBeNull();
  });

  it('shows a negative amount with U+2212, a zero change as flat and no margin rate on a non-positive costed HT', () => {
    const credit = bucket({ ht: -50_000, ttc: -56_500, cost: 10_000, costedHt: -50_000, evolution: { ht: 0, ttc: 0 } });
    render(renderTable({ buckets: [credit] }));
    const cells = within(bodyRows()[0]).getAllByRole('cell');
    expect(within(cells[1]).getByText('−50.000 FCP')).toBeInTheDocument();
    expect(cells[3]).toHaveTextContent(/^—$/);
    // Flat is a badge; a missing comparison is the empty marker (the year-ago cell here).
    expect(cells[3].querySelector('[data-missing]')).toBeNull();
    expect(cells[4].querySelector('[data-missing]')).not.toBeNull();
    expect(cells[5]).toHaveTextContent(/^—$/);
  });

  it('scrolls sideways in a keyboard-focusable region', () => {
    render(renderTable());
    const region = screen.getByRole('region', { name: 'Detail by period' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toHaveClass('overflow-x-auto');
    expect(within(region).getByRole('table', { name: 'Detail by period' })).toBeInTheDocument();
  });

  it('marks the cost coverage of a period whose cost is only partly known', () => {
    const partial = bucket({ key: '2026-08', label: 'août 2026', start: '2026-08-01', end: '2026-08-31', ht: 400_000, cost: 150_000, costedHt: 300_000 });
    const nearly = bucket({ key: '2026-07', label: 'juil. 2026', start: '2026-07-01', end: '2026-07-31', ht: 400_000, cost: 100_000, costedHt: 399_999 });
    const { unmount } = render(renderTable({ buckets: [nearly, partial, sept] }));
    const [septRow, augRow, julRow] = bodyRows();
    const marker = within(augRow).getByText('cost known: 75 %');
    expect(marker.closest('[role="cell"]')).toHaveAttribute('title', 'cost known on 75 % of revenue HT');
    expect(within(septRow).queryByText(/cost known/)).toBeNull();
    expect(within(julRow).queryByText(/cost known/)).toBeNull();
    unmount();
    render(renderTable({ buckets: [partial], canMargin: false }));
    expect(screen.queryByText(/cost known/)).toBeNull();
  });

  it('details the margin under an opened period: costed HT, each cost part, the margin', async () => {
    stubItems([]);
    const parts = { ...sept, costParts: { items: 100_000, filament: 50_000, energy: 0, wear: 120_000, labor: 30_000 } };
    render(renderTable({ buckets: [parts] }));
    fireEvent.click(screen.getByRole('button', { name: 'sept. 2026' }));
    const breakdown = await screen.findByRole('group', { name: 'Gross margin breakdown' });
    expect(breakdown).toHaveTextContent('Costed revenue HT500.000 FCP');
    expect(breakdown).toHaveTextContent('Item costs−100.000 FCP');
    expect(breakdown).toHaveTextContent('Printer wear−120.000 FCP');
    expect(breakdown).toHaveTextContent('Labour−30.000 FCP');
    // A zero part is left out.
    expect(within(breakdown).queryByText('Energy')).toBeNull();
    expect(breakdown).toHaveTextContent('Gross margin HT200.000 FCP');
  });

  it('shows no breakdown without the margin right', () => {
    stubItems([]);
    render(renderTable({ buckets: [{ ...sept, costParts: { items: 1 } }], canMargin: false }));
    fireEvent.click(screen.getByRole('button', { name: 'sept. 2026' }));
    expect(screen.queryByRole('group', { name: 'Gross margin breakdown' })).toBeNull();
  });

  it('shows the margin amount with its rate and explains the column', () => {
    render(renderTable());
    const cells = within(bodyRows()[0]).getAllByRole('cell');
    expect(cells[5]).toHaveTextContent('186.000 FCP 30 %');
    expect(screen.getByRole('columnheader', { name: 'Margin' })).toHaveAccessibleDescription('Gross margin HT, at current cost (dealer price, else purchase price); services at their print costs (filament, energy, printer wear) and labour since July 2026');
  });

  it('shows the margin only with view_margin and cost fields', async () => {
    stubItems([item()]);
    const { unmount } = render(renderTable({ canMargin: false }));
    expect(screen.queryByRole('columnheader', { name: 'Margin' })).toBeNull();
    expect(within(bodyRows()[0]).getAllByRole('cell')).toHaveLength(7);
    expect(screen.queryByText('186.000 FCP')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /oct\. 2026/ }));
    await screen.findByText('PLA Basic 1 kg');
    const itemRow = screen.getByText('PLA Basic 1 kg').closest('[role="row"]') as HTMLElement;
    expect(within(itemRow).getAllByRole('cell')).toHaveLength(7);
    expect(screen.queryByText('14.000 FCP')).toBeNull();
    unmount();
    const { unmount: u1 } = render(renderTable());
    expect(within(bodyRows()[0]).getAllByRole('cell')).toHaveLength(8);
    u1();
    unmount();
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
    expect(screen.getByText('14.000 FCP')).toBeInTheDocument();
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
