import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { RevenueMovers } from '../../../components/revenue/RevenueMovers';
import type { Mover, MoversResponse } from '../../../components/revenue/lib/types';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const mover = (key: string, delta: number, change: number | null): Mover => ({ key, label: key, current: 0, previous: 0, delta, change });

const payload = (o: Partial<MoversResponse> = {}): MoversResponse => ({
  granularity: 'month',
  key: '2026-11',
  current: { from: '2026-11-01', to: '2026-11-19' },
  previous: { from: '2026-10-01', to: '2026-10-19' },
  items: { up: [mover('Printer X1', 412_000, 0.5)], down: [mover('PETG white', -61_200, null)] },
  brands: { up: [mover('Bambu', 300_000, 0.2)], down: [] },
  totals: { current: 1_000_000, previous: 800_000 },
  ...o,
});

function stubMovers() {
  const fetchMock = vi.fn(async (u: string) => json(u.includes('cfrom=') ? payload({ granularity: null, key: null }) : payload()));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const renderMovers = (version: unknown = 0) => (
  <RevenueMovers granularity="month" bucketKey="2026-11" bucketLabel="nov. 2026" filterParams="&brand=bambu" version={version} today="2026-11-19" />
);

afterEach(() => vi.unstubAllGlobals());

describe('RevenueMovers', () => {
  it('lists the rises then the falls of the last bucket with the page filters', async () => {
    const fetchMock = stubMovers();
    render(renderMovers());
    expect(await screen.findByText('Printer X1')).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/revenue/movers?granularity=month&key=2026-11&brand=bambu');
    expect(screen.getByText('nov. 2026 vs previous period (to date) · HT')).toBeInTheDocument();
    const up = screen.getAllByText('▲ Rises');
    const down = screen.getAllByText('▼ Falls');
    expect(up[0].compareDocumentPosition(down[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('▲ +412.000 FCP')).toHaveClass('text-status-ok');
    expect(screen.getByText('▼ −61.200 FCP')).toHaveClass('text-status-error');
    expect(screen.getByText('new')).toBeInTheDocument();
    expect(screen.getByText('None')).toBeInTheDocument();
  });

  it('compares two periods prefilled from the bucket and its previous one', async () => {
    const fetchMock = stubMovers();
    render(renderMovers());
    await screen.findByText('Printer X1');
    fireEvent.click(screen.getByRole('button', { name: '⇄ Compare two periods' }));
    expect(screen.getByLabelText('Period A, start')).toHaveValue('2026-11-01');
    expect(screen.getByLabelText('Period A, end')).toHaveValue('2026-11-19');
    expect(screen.getByLabelText('Period B, start')).toHaveValue('2026-10-01');
    expect(screen.getByLabelText('Period B, end')).toHaveValue('2026-10-19');
    await waitFor(() =>
      expect(fetchMock.mock.calls.map((c) => c[0])).toContain('/api/v1/revenue/movers?from=2026-11-01&to=2026-11-19&cfrom=2026-10-01&cto=2026-10-19&brand=bambu'),
    );
    expect(await screen.findByText('A 1.000.000 FCP · B 800.000 FCP · +200.000 FCP (+25.0 %) HT')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Period B, start'), { target: { value: '2026-09-01' } });
    await waitFor(() =>
      expect(fetchMock.mock.calls.map((c) => c[0])).toContain('/api/v1/revenue/movers?from=2026-11-01&to=2026-11-19&cfrom=2026-09-01&cto=2026-10-19&brand=bambu'),
    );
    fireEvent.click(screen.getByRole('button', { name: '← Period movements' }));
    expect(screen.queryByLabelText('Period A, start')).toBeNull();
  });

  it('does not request an inverted or out-of-bounds pair and marks the bad input', async () => {
    const fetchMock = stubMovers();
    render(renderMovers());
    await screen.findByText('Printer X1');
    fireEvent.click(screen.getByRole('button', { name: '⇄ Compare two periods' }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('cfrom='))).toBe(true));
    const before = fetchMock.mock.calls.length;
    fireEvent.change(screen.getByLabelText('Period A, start'), { target: { value: '2026-11-25' } });
    expect(screen.getByLabelText('Period A, start')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Period A, end')).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(screen.getByLabelText('Period B, end'), { target: { value: '2026-12-01' } });
    expect(screen.getByLabelText('Period B, end')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Period B, start')).not.toHaveAttribute('aria-invalid');
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it('refetches when the data version changes', async () => {
    const fetchMock = stubMovers();
    const { rerender } = render(renderMovers(1));
    await screen.findByText('Printer X1');
    rerender(renderMovers(2));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
