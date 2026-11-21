import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { RevenueBridge } from '../../../components/revenue/RevenueBridge';
import type { PvmResponse } from '../../../components/revenue/lib/types';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const payload = (o: Partial<PvmResponse> = {}): PvmResponse => ({
  comparable: true, from: '2026-11-01', to: '2026-11-20', previousFrom: '2026-10-12', previousTo: '2026-10-31',
  previous: 1_000_000, volume: 150_000, mix: -40_000, price: 60_000, new: 90_000, lost: -110_000, current: 1_150_000,
  items: [
    { name: 'PLA Basic', effect: 120_000, volume: 100_000, price: 20_000, kind: 'both' },
    { name: 'Kayak', effect: -110_000, volume: 0, price: 0, kind: 'lost' },
  ],
  ...o,
});
const show = (p: PvmResponse) => {
  const fetchMock = vi.fn(async () => json(p));
  vi.stubGlobal('fetch', fetchMock);
  render(<RevenueBridge from="2026-11-01" to="2026-11-20" filterParams="&kind=goods" version={0} />);
  return fetchMock;
};

afterEach(() => vi.unstubAllGlobals());

describe('RevenueBridge', () => {
  it('walks from the previous period to this one, one signed step per effect', async () => {
    const fetchMock = show(payload());
    const steps = within(await screen.findByTestId('revenue-bridge')).getAllByRole('listitem');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/revenue/pvm?from=2026-11-01&to=2026-11-20&kind=goods');
    expect(steps.map((s) => s.textContent)).toEqual([
      'Previous period1.000.000 FCP', 'Volume+150.000 FCP', 'Mix−40.000 FCP', 'Price+60.000 FCP',
      'New items+90.000 FCP', 'Items no longer sold−110.000 FCP', 'This period1.150.000 FCP',
    ]);
    expect(screen.getByText('Compared with 12/10 → 31/10')).toBeInTheDocument();
  });

  it('places each bar where the running total stands', async () => {
    show(payload());
    const bars = (await screen.findByTestId('revenue-bridge')).querySelectorAll<HTMLElement>('[data-bar]');
    // Scale: the highest running total, 1 260 000 (after price and new items).
    expect(bars[0].style.width).toBe(`${(1_000_000 / 1_260_000) * 100}%`);
    expect(bars[1].style.left).toBe(`${(1_000_000 / 1_260_000) * 100}%`);
    expect(bars[2].dataset.bar).toBe('down');
    expect(bars[2].style.left).toBe(`${(1_110_000 / 1_260_000) * 100}%`);
  });

  it('lists the items behind the change', async () => {
    show(payload());
    expect((await screen.findByText('PLA Basic')).closest('div')).toHaveTextContent('+120.000 FCP');
    expect(screen.getByText('Kayak').closest('div')).toHaveTextContent('no longer sold');
  });

  it('says so when there is no earlier period in the history to compare with', async () => {
    show(payload({ comparable: false }));
    expect(await screen.findByText('No earlier period of the same length in the history: pick a shorter period.')).toBeInTheDocument();
    expect(screen.queryByTestId('revenue-bridge')).toBeNull();
  });

  it('says so when neither period has sales', async () => {
    show(payload({ previous: 0, current: 0, volume: 0, mix: 0, price: 0, new: 0, lost: 0, items: [] }));
    expect(await screen.findByText('No sales in either period')).toBeInTheDocument();
  });
});
