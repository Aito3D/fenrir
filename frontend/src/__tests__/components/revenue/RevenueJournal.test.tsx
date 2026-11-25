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

describe('RevenueJournal', () => {
  it('lists the day by goods then services with totals, and steps back or to the month', async () => {
    const fetchMock = vi.fn(async (u: string) =>
      json({
        from: '', to: '',
        items: u.includes('from=2026-11-23') ? [] : [row({}), row({ itemId: '2', name: 'Custom print', sku: '', quantity: 1, ht: 8_500, ttc: 9_605, kind: 'service', nature: null, brand: null })],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<RevenueJournal today="2026-11-24" filterParams="&kind=goods" version={0} />);

    expect(await screen.findByText('PLA black')).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/revenue/items?from=2026-11-24&to=2026-11-24&kind=goods');
    const total = within(screen.getByRole('table')).getAllByRole('row').at(-1)!;
    expect(within(total).getByText('Total')).toBeInTheDocument();
    expect(within(total).getByText('5')).toBeInTheDocument();
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
    expect(fetchMock.mock.calls.at(-1)![0]).toBe('/api/v1/revenue/items?from=2026-11-01&to=2026-11-24&kind=goods');
    fireEvent.click(screen.getByLabelText('Previous period (←)'));
    await screen.findByText('This month');
    expect(fetchMock.mock.calls.at(-1)![0]).toBe('/api/v1/revenue/items?from=2026-10-01&to=2026-10-31&kind=goods');
  });
});
