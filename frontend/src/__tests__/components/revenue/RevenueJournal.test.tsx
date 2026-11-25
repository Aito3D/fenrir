import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { RevenueJournal } from '../../../components/revenue/RevenueJournal';
import { journalStep, journalWindow } from '../../../components/revenue/lib/dates';
import type { RevenueItemRow } from '../../../components/revenue/lib/types';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const row = (o: Partial<RevenueItemRow>): RevenueItemRow => ({
  itemId: '1', name: 'PLA black', sku: 'PLA-BK', quantity: 4, ht: 12_000, ttc: 13_560, nature: 'Filament', brand: 'Bambu', kind: 'goods', reason: 'default', ...o,
} as RevenueItemRow);

afterEach(() => vi.unstubAllGlobals());

describe('journal periods', () => {
  it('cuts the current month at today and keeps a past month whole', () => {
    expect(journalWindow('day', '2026-11-24', '2026-11-24')).toEqual({ from: '2026-11-24', to: '2026-11-24' });
    expect(journalWindow('month', '2026-11-24', '2026-11-24')).toEqual({ from: '2026-11-01', to: '2026-11-24' });
    expect(journalWindow('month', '2024-02-10', '2026-11-24')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
  });

  it('steps by day or month and stops at the history bounds', () => {
    expect(journalStep('day', '2026-11-01', -1, '2026-11-24')).toBe('2026-10-31');
    expect(journalStep('day', '2026-11-24', 1, '2026-11-24')).toBeNull();
    expect(journalStep('day', '2024-01-01', -1, '2026-11-24')).toBeNull();
    expect(journalStep('month', '2026-01-31', -1, '2026-11-24')).toBe('2025-12-01');
    expect(journalStep('month', '2026-10-01', 1, '2026-11-24')).toBe('2026-11-24');
    expect(journalStep('month', '2026-11-24', 1, '2026-11-24')).toBeNull();
    expect(journalStep('month', '2024-01-15', -1, '2026-11-24')).toBeNull();
  });
});

const ITEMS = '/api/v1/revenue/items';
/** The item list for `/items`, a series for everything else (the record badge and the unfolded row). */
const mockFetch = (items: (u: string) => RevenueItemRow[], buckets: (u: string) => unknown[] = () => []) =>
  vi.fn(async (u: string) => json(u.startsWith(ITEMS) ? { from: '', to: '', items: items(u) } : { buckets: buckets(u) }));
const itemCalls = (f: ReturnType<typeof mockFetch>) => f.mock.calls.map((c) => c[0]).filter((u) => u.startsWith(ITEMS));
const names = () => [...document.querySelectorAll('button[aria-expanded]')].map((b) => b.querySelector('[title]')!.textContent);
const totalRow = () => within(screen.getByRole('table')).getAllByRole('row').at(-1)!;

// Margin 3 000 at 25 %, a 300 loss, and an item without a cost: 2 700 on the 14 000 costed, 70 % of the 20 000.
const LEDGER = [
  row({ cost: 9_000 }),
  row({ itemId: '2', name: 'Glue', sku: 'GL', quantity: 1, ht: 2_000, ttc: 2_260, cost: 2_300, brand: '3DLAC', nature: 'Consumable' }),
  row({ itemId: '3', name: 'Silk gold', sku: 'SG', quantity: 2, ht: 6_000, ttc: 6_780, cost: null, brand: null }),
];

describe('RevenueJournal', () => {
  it('lists the day by goods then services with totals, and steps back or to the month', async () => {
    const fetchMock = mockFetch((u) =>
      u.includes('from=2026-11-23') ? [] : [row({}), row({ itemId: '2', name: 'Custom print', sku: '', quantity: 1, ht: 8_500, ttc: 9_605, kind: 'service', nature: null, brand: null })],
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<RevenueJournal today="2026-11-24" filterParams="&kind=goods" version={0} taxMode="ht" canMargin={false} />);

    expect(await screen.findByText('PLA black')).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/revenue/items?from=2026-11-24&to=2026-11-24&kind=goods');
    expect(within(totalRow()).getByText('Total')).toBeInTheDocument();
    expect(within(totalRow()).getByText('5')).toBeInTheDocument();
    const [goods, services] = screen.getAllByRole('rowgroup').filter((g) => g.dataset.slot);
    expect(within(goods).getByText('Goods')).toBeInTheDocument();
    expect(within(services).getByText('Custom print')).toBeInTheDocument();
    expect(screen.getByLabelText('Next period (→)')).toBeDisabled();
    expect(screen.queryByText('Today')).toBeNull();

    fireEvent.click(screen.getByLabelText('Previous period (←)'));
    expect(await screen.findByText('No Aito3D sales in this period.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Today'));
    expect(await screen.findByText('PLA black')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Month'));
    await screen.findByText('PLA black');
    expect(itemCalls(fetchMock).at(-1)).toBe('/api/v1/revenue/items?from=2026-11-01&to=2026-11-24&kind=goods');
    fireEvent.click(screen.getByLabelText('Previous period (←)'));
    await screen.findByText('This month');
    expect(itemCalls(fetchMock).at(-1)).toBe('/api/v1/revenue/items?from=2026-10-01&to=2026-10-31&kind=goods');
  });

  it('shows one amount column in the page tax mode', async () => {
    vi.stubGlobal('fetch', mockFetch(() => [row({})]));
    const { rerender } = render(<RevenueJournal today="2026-11-24" filterParams="" version={0} taxMode="ht" canMargin={false} />);
    await screen.findByText('PLA black');
    expect(screen.getByRole('columnheader', { name: /Revenue HT/ })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /Revenue TTC/ })).toBeNull();
    expect(within(totalRow()).getByText('12.000')).toBeInTheDocument();

    rerender(<RevenueJournal today="2026-11-24" filterParams="" version={0} taxMode="ttc" canMargin={false} />);
    expect(screen.getByRole('columnheader', { name: /Revenue TTC/ })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /Revenue HT/ })).toBeNull();
    expect(within(totalRow()).getByText('13.560')).toBeInTheDocument();
  });

  it('keeps cost, margin and share out without the margin permission, by the prop or by the payload', async () => {
    vi.stubGlobal('fetch', mockFetch(() => LEDGER));
    const { unmount } = render(<RevenueJournal today="2026-11-24" filterParams="" version={0} taxMode="ht" canMargin={false} />);
    await screen.findByText('PLA black');
    for (const text of ['Margin', 'Cost', 'Share', 'cost unknown', 'at a loss', 'Margin rate']) expect(screen.queryByText(text)).toBeNull();
    expect(names()).toEqual(['PLA black', 'Silk gold', 'Glue']); // revenue, largest first
    unmount();

    vi.stubGlobal('fetch', mockFetch(() => [row({})])); // no `cost` field: stripped by the server
    render(<RevenueJournal today="2026-11-24" filterParams="" version={0} taxMode="ht" canMargin />);
    await screen.findByText('PLA black');
    expect(screen.queryByText('Margin')).toBeNull();
  });

  it('totals margin and rate on the costed items only, flags a loss and an unknown cost, sorts and ranks the day', async () => {
    const day = (d: number, ht: number) => ({ start: `2026-11-${String(d).padStart(2, '0')}`, end: `2026-11-${String(d).padStart(2, '0')}`, ht });
    const fetchMock = mockFetch(() => LEDGER, () => [day(3, 50_000), day(10, 9_000), day(12, 8_000), day(17, 7_000), day(24, 20_000)]);
    vi.stubGlobal('fetch', fetchMock);
    render(<RevenueJournal today="2026-11-24" filterParams="&kind=goods" version={0} taxMode="ttc" canMargin />);
    await screen.findByText('PLA black');

    const cells = within(totalRow()).getAllByRole('cell').map((c) => c.textContent);
    expect(cells).toEqual(['7', '22.600', '11.300', '2.700', '19.3 %', '100.0 %']); // revenue TTC, margin still HT
    expect(screen.getByText('cost known on 70 % of revenue HT')).toBeInTheDocument();
    expect(within(screen.getByText('Glue').closest('tr')!).getByText('at a loss')).toBeInTheDocument();
    expect(within(screen.getByText('Glue').closest('tr')!).getByText('−300')).toHaveClass('text-status-error');
    const unknown = within(screen.getByText('Silk gold').closest('tr')!);
    expect(unknown.getByText('cost unknown')).toBeInTheDocument();
    expect(unknown.getAllByText('—')).toHaveLength(4); // cost, margin, rate, share
    expect(within(screen.getByText('PLA black').closest('tr')!).getByText('25.0 %')).toHaveClass('text-status-warning');

    expect(names()).toEqual(['PLA black', 'Glue', 'Silk gold']); // margin, largest first, unknown last
    const marginHead = screen.getByRole('columnheader', { name: /Margin/ });
    expect(marginHead).toHaveAttribute('aria-sort', 'descending');
    fireEvent.click(within(marginHead).getByRole('button'));
    expect(marginHead).toHaveAttribute('aria-sort', 'ascending');
    expect(names()).toEqual(['Silk gold', 'Glue', 'PLA black']);
    fireEvent.click(screen.getByRole('button', { name: 'Product' }));
    expect(names()).toEqual(['Glue', 'PLA black', 'Silk gold']);

    expect(fetchMock.mock.calls.map((c) => c[0])).toContain('/api/v1/revenue?granularity=day&from=2026-11-01&to=2026-11-24&kind=goods');
    expect(await screen.findByText(/No\. 2 day of the month/)).toBeInTheDocument();
  });

  it('shares the period production cost between the services without a cost, and agrees with the bucket', async () => {
    const service = (o: Partial<RevenueItemRow>) => row({ kind: 'service', sku: '', brand: null, nature: null, quantity: 1, cost: null, costedHt: 0, ...o });
    const items = [
      row({ cost: 9_000, costedHt: 12_000 }),
      service({ itemId: '2', name: 'Impression3D', ht: 8_000, ttc: 9_040 }),
      service({ itemId: '3', name: 'Modelisation3D', ht: 2_000, ttc: 2_260 }),
      service({ itemId: '4', name: 'Scan3D', ht: 1_000, ttc: 1_130, cost: 400, costedHt: 1_000 }),
    ];
    // The server's bucket: 13 000 with an own cost + the 10 000 pool; 9 400 of item costs + 4 000 of production.
    const bucket = { start: '2026-11-24', end: '2026-11-24', ht: 23_000, costedHt: 23_000, cost: 13_400, costParts: { items: 9_400, filament: 1_500, labor: 2_500 } };
    let land!: () => void;
    const landed = new Promise<void>((r) => (land = r));
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (u.startsWith(ITEMS)) return json({ from: '', to: '', items });
      await landed;
      return json({ buckets: [bucket] });
    }));
    render(<RevenueJournal today="2026-11-24" filterParams="" version={0} taxMode="ht" canMargin />);

    // The series has not landed: no verdict on the services yet.
    const print = () => within(screen.getByText('Impression3D').closest('tr')!);
    await screen.findByText('Impression3D');
    expect(print().getAllByText('—')).toHaveLength(4);
    expect(screen.queryByText('cost unknown')).toBeNull();
    expect(screen.queryByText('cost shared')).toBeNull();

    land();
    expect(await screen.findAllByText('cost shared')).toHaveLength(2);
    expect(screen.queryByText('cost unknown')).toBeNull();
    expect(print().getAllByRole('cell').map((c) => c.textContent)).toEqual(['1', '8.000', '3.200', '4.800', '60.0 %', '50.0 %']);
    expect(within(screen.getByText('Scan3D').closest('tr')!).getByText('400')).toBeInTheDocument(); // its own cost, no chip
    const total = within(totalRow()).getAllByRole('cell').map((c) => c.textContent);
    expect(total.slice(2, 4)).toEqual(['13.400', '9.600']); // bucket.cost, bucket.costedHt − bucket.cost
    expect(screen.getByText('cost known on 100 % of revenue HT')).toBeInTheDocument();
  });

  it('groups by brand with a subtotal each, the best margin first, and remembers the choice', async () => {
    vi.stubGlobal('fetch', mockFetch(() => [...LEDGER, row({ itemId: '4', name: 'PETG white', ht: 5_000, ttc: 5_650, cost: 4_000 })]));
    const { unmount } = render(<RevenueJournal today="2026-11-24" filterParams="" version={0} taxMode="ht" canMargin />);
    await screen.findByText('PLA black');
    fireEvent.click(screen.getByRole('button', { name: 'Brand' }));

    const groups = screen.getAllByRole('rowgroup').filter((g) => g.dataset.slot === 'revenue-journal-group');
    const heads = groups.map((g) => within(g).getAllByRole('row')[0]);
    expect(heads.map((h) => within(h).getByRole('rowheader').textContent)).toEqual(['Bambu · 2', '3DLAC · 1', 'No brand · 1']);
    // Bambu: 17 000 sold, 13 000 cost, 4 000 margin = 23.5 %, more than the period's 3 700.
    expect(within(heads[0]).getAllByRole('cell').map((c) => c.textContent)).toEqual(['17.000', '13.000', '4.000', '23.5 %', '108.1 %']);
    expect(localStorage.getItem('revenue-journal-group')).toBe('brand');
    unmount();

    render(<RevenueJournal today="2026-11-24" filterParams="" version={0} taxMode="ht" canMargin />);
    await screen.findByText('PLA black');
    expect(screen.getByRole('button', { name: 'Brand' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('unfolds an item on its unit figures and its last 30 days, fetched on expand', async () => {
    const fetchMock = mockFetch(() => LEDGER, (u) => (u.includes('items=1') ? Array.from({ length: 30 }, (_, i) => ({ start: '', end: '', ht: i % 10 === 0 ? 500 : 0, ttc: 0 })) : []));
    vi.stubGlobal('fetch', fetchMock);
    render(<RevenueJournal today="2026-11-24" filterParams="&items=1,2,3&kind=goods" version={0} taxMode="ht" canMargin />);
    const toggle = (await screen.findByText('PLA black')).closest('button')!;
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const drill = '/api/v1/revenue?granularity=day&from=2026-10-26&to=2026-11-24&items=1&kind=goods';
    expect(fetchMock.mock.calls.map((c) => c[0])).not.toContain(drill);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText('Sold on 3 of the last 30 days')).toBeInTheDocument();
    expect(fetchMock.mock.calls.map((c) => c[0])).toContain(drill);
    const detail = document.querySelector<HTMLElement>('[data-slot="revenue-journal-detail"]')!;
    expect(within(detail).getByText('Average unit price HT').nextElementSibling).toHaveTextContent('3.000');
    expect(within(detail).getByText('Unit cost').nextElementSibling).toHaveTextContent('2.250');
    expect(within(detail).getByText('Margin per unit').nextElementSibling).toHaveTextContent('750');

    fireEvent.click(toggle);
    expect(document.querySelector('[data-slot="revenue-journal-detail"]')).toBeNull();
  });
});
