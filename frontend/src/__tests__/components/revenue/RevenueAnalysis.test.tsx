import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { RevenueAnalysis } from '../../../components/revenue/RevenueAnalysis';
import type { AbcClass, AbcRow, AnalysisResponse, DormantRow, MarginRow } from '../../../components/revenue/lib/types';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const abcRow = (i: number, ht: number, cls: AbcClass, share: number, cumShare: number, o: Partial<AbcRow> = {}): AbcRow => ({
  itemId: `i${i}`,
  name: `Product ${i}`,
  sku: `SKU-${i}`,
  quantity: 1,
  ht,
  ttc: ht,
  nature: 'Filaments',
  brand: 'Bambu Lab',
  kind: 'goods',
  reason: 'in',
  share,
  cumShare,
  cls,
  ...o,
});

const margin = (key: string, ht: number, marginAmt: number, rate: number | null, coverage: number): MarginRow => ({
  key,
  ht,
  costedHt: Math.round(ht * coverage),
  cost: Math.round(ht * coverage) - marginAmt,
  margin: marginAmt,
  rate,
  coverage,
});

const dormant = (itemId: string, name: string, o: Partial<DormantRow> = {}): DormantRow => ({
  itemId,
  name,
  sku: 'RES-1',
  brand: 'Elegoo',
  ht: 45_000,
  quantity: 3,
  lastDay: '2026-07-02',
  ...o,
});

const payload = (o: Partial<AnalysisResponse> = {}): AnalysisResponse => ({
  from: '2026-01-01',
  to: '2026-11-19',
  abc: {
    rows: [
      abcRow(1, 600_000, 'A', 0.6, 0.6, { name: 'Bambu H2D', sku: 'H2D-01' }),
      abcRow(2, 250_000, 'B', 0.25, 0.85),
      abcRow(3, 150_000, 'C', 0.15, 1, { brand: null }),
    ],
    total: 1_000_000,
    classes: { A: { count: 1, ht: 600_000 }, B: { count: 1, ht: 250_000 }, C: { count: 2, ht: 150_000 } },
  },
  marginByBrand: [margin('Bambu Lab', 800_000, 200_000, 0.25, 1), margin('Elegoo', 100_000, -10_000, -0.13, 0.8), margin('Zero', 0, 0, null, 0)],
  marginByNature: [margin('Filaments', 500_000, 150_000, 0.3, 1)],
  dormant: [dormant('d1', 'Résine grise 1 L'), dormant('d2', 'Plateau PEI', { brand: null, sku: '', lastDay: '' })],
  ...o,
});

function stub(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => json(body, status));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const view = (version: unknown = 0) => <RevenueAnalysis from="2026-01-01" to="2026-11-19" filterParams="&kind=goods" version={version} />;

afterEach(() => vi.unstubAllGlobals());

describe('RevenueAnalysis', () => {
  it('requests the analysis of the page range with the page filters', async () => {
    const fetchMock = stub(payload());
    render(view());
    expect(await screen.findByText('Bambu H2D')).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/revenue/analysis?from=2026-01-01&to=2026-11-19&kind=goods');
  });

  it('shows one Pareto tile per class with its count and shares', async () => {
    stub(payload());
    render(view());
    const tile = (await screen.findByText('Class C · products')).closest('.rounded-lg') as HTMLElement;
    expect(tile).toHaveTextContent('2');
    expect(tile).toHaveTextContent('50 % of products · 15 % of revenue');
    expect(screen.getByText('Class A · products').closest('.rounded-lg')).toHaveTextContent('25 % of products · 60 % of revenue');
    expect(screen.getByRole('img', { name: 'Products: A 25 %, B 25 %, C 50 %' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Revenue: A 60 %, B 25 %, C 15 %' })).toBeInTheDocument();
    expect(screen.getByText('HT · A = 80 % of revenue, B = up to 95 %, C = the rest')).toBeInTheDocument();
  });

  it('lists each product with its class letter, SKU, amount, share and cumulative share', async () => {
    stub(payload());
    render(view());
    const list = await screen.findByRole('list', { name: 'Pareto law (ABC)' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.querySelector('[data-cls]')?.textContent)).toEqual(['A', 'B', 'C']);
    expect(within(rows[0]).getByText('Bambu H2D')).toHaveAttribute('title', 'Bambu H2D');
    expect(rows[0]).toHaveTextContent('Bambu H2D');
    expect(rows[0]).toHaveTextContent('H2D-01');
    expect(rows[0]).toHaveTextContent('600.000 FCP · 60.0 %');
    expect(rows[0]).toHaveTextContent('Brand: Bambu Lab · Cumulative: 60 %');
    expect(rows[1]).toHaveTextContent('Cumulative: 85 %');
    expect(rows[2]).toHaveTextContent('Brand: —');
  });

  it('shows the first 25 rows then expands to all with « Voir les N premiers »', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => abcRow(i + 1, 1000 - i, 'A', 0.01, 0.01 * (i + 1)));
    stub(payload({ abc: { rows, total: 100_000, classes: { A: { count: 40, ht: 100_000 }, B: { count: 0, ht: 0 }, C: { count: 0, ht: 0 } } } }));
    render(view());
    const list = await screen.findByRole('list', { name: 'Pareto law (ABC)' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(25);
    const more = screen.getByRole('button', { name: 'Show the first 30' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(more);
    expect(within(list).getAllByRole('listitem')).toHaveLength(30);
    const less = screen.getByRole('button', { name: 'Collapse (out of 40)' });
    expect(less).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(less);
    expect(within(list).getAllByRole('listitem')).toHaveLength(25);
  });

  it('has no expander at 25 rows or fewer, and says when there is nothing to rank', async () => {
    stub(payload({ abc: { rows: [], total: 0, classes: { A: { count: 0, ht: 0 }, B: { count: 0, ht: 0 }, C: { count: 0, ht: 0 } } } }));
    render(view());
    expect(await screen.findByText('Nothing to rank.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show the first/ })).toBeNull();
    expect(screen.getByText('Class A · products').closest('.rounded-lg')).toHaveTextContent('— of products · — of revenue');
  });

  it('shows the margin by brand, then by nature, with rate, amount and the amber coverage note under 95 %', async () => {
    stub(payload());
    render(view());
    const list = await screen.findByRole('list', { name: 'Gross margin HT' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Bambu Lab');
    expect(rows[0]).toHaveTextContent('25 % · 200.000 FCP');
    expect(rows[0]).not.toHaveTextContent('cost known');
    expect(rows[1]).toHaveTextContent('−13 % · −10.000 FCP');
    expect(within(rows[1]).getByText('cost known on 80 % of 100.000 FCP')).toHaveClass('text-amber-400');
    expect(screen.getByText("At today's cost (Dealer price, otherwise purchase price), on items that have a cost.")).toBeInTheDocument();

    const brand = screen.getByRole('button', { name: 'Brand' });
    expect(brand).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Nature' }));
    const natureRows = within(screen.getByRole('list', { name: 'Gross margin HT' })).getAllByRole('listitem');
    expect(natureRows).toHaveLength(1);
    expect(natureRows[0]).toHaveTextContent('Filaments');
    expect(natureRows[0]).toHaveTextContent('30 % · 150.000 FCP');
  });

  it('shows « — » for a margin rate that cannot be computed and an empty-state line with no rows', async () => {
    stub(payload({ marginByBrand: [margin('Sans marque', 50_000, 0, null, 0)], marginByNature: [] }));
    render(view());
    const row = within(await screen.findByRole('list', { name: 'Gross margin HT' })).getByRole('listitem');
    expect(row).toHaveTextContent('— · 0 FCP');
    expect(row.querySelector('[data-bar]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Nature' }));
    expect(screen.getByText('No data.')).toBeInTheDocument();
  });

  it('draws a green bar for a positive margin, a red one from the absolute value for a negative margin, and none at zero', async () => {
    stub(payload({ marginByBrand: [margin('Bambu Lab', 800_000, 200_000, 0.25, 1), margin('Elegoo', 100_000, -10_000, -0.13, 1), margin('Flat', 50_000, 0, 0, 1)] }));
    render(view());
    const rows = within(await screen.findByRole('list', { name: 'Gross margin HT' })).getAllByRole('listitem');
    const bars = rows.map((r) => r.querySelector<HTMLElement>('[data-bar]'));
    expect(bars[0]).toHaveClass('bg-bambu-green');
    expect(bars[0]!.style.width).toBe('100%');
    expect(bars[1]).toHaveClass('bg-status-error');
    expect(bars[1]!.style.width).toBe('5%');
    expect(bars[2]).toBeNull();
  });

  it('translates the server fallback labels « Sans marque » and « Sans nature »', async () => {
    stub(payload({ marginByBrand: [margin('Sans marque', 50_000, 10_000, 0.2, 1)], marginByNature: [margin('Sans nature', 50_000, 10_000, 0.2, 1)] }));
    render(view());
    const list = await screen.findByRole('list', { name: 'Gross margin HT' });
    expect(within(list).getByText('No brand')).toBeInTheDocument();
    expect(screen.queryByText('Sans marque')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Nature' }));
    expect(within(screen.getByRole('list', { name: 'Gross margin HT' })).getByText('No category')).toBeInTheDocument();
  });

  it('renders no margin card when only one of the two margin lists is present', async () => {
    const p = payload();
    delete p.marginByNature;
    stub(p);
    render(view());
    expect(await screen.findByText('Bambu H2D')).toBeInTheDocument();
    expect(screen.queryByText('Gross margin HT')).toBeNull();
  });

  it('renders no margin card at all when the payload has no margin (no revenue:view_margin)', async () => {
    const p = payload();
    delete p.marginByBrand;
    delete p.marginByNature;
    stub(p);
    render(view());
    expect(await screen.findByText('Bambu H2D')).toBeInTheDocument();
    expect(screen.queryByText('Gross margin HT')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Brand' })).toBeNull();
    expect(screen.queryByText(/At today's cost/)).toBeNull();
  });

  it('lists dormant products with brand, SKU, amount and last sale, without any link', async () => {
    stub(payload());
    render(view());
    const title = await screen.findByText('Not sold for 90 days');
    const panel = title.closest('section') as HTMLElement;
    expect(within(panel).getByText('Résine grise 1 L')).toBeInTheDocument();
    expect(within(panel).getByText('Elegoo · RES-1')).toBeInTheDocument();
    expect(within(panel).getAllByText('45.000 FCP')).toHaveLength(2);
    expect(within(panel).getByText('last sale Jul 2, 2026')).toBeInTheDocument();
    expect(within(panel).getAllByText(/last sale/)).toHaveLength(1);
    expect(within(panel).queryByRole('link')).toBeNull();
    expect(document.querySelector('a')).toBeNull();
  });

  it('says « Aucun. » when no product is dormant', async () => {
    stub(payload({ dormant: [] }));
    render(view());
    expect(await screen.findByText('None.')).toBeInTheDocument();
  });

  it('shows the server error when the first load fails', async () => {
    stub({ detail: 'from must be YYYY-MM-DD' }, 422);
    render(view());
    expect(await screen.findByRole('alert')).toHaveTextContent('from must be YYYY-MM-DD');
  });

  it('refetches when the page payload moves', async () => {
    const fetchMock = stub(payload());
    const { rerender } = render(view(0));
    await screen.findByText('Bambu H2D');
    rerender(view(1));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
