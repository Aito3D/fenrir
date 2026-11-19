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

const renderMovers = (version: unknown = 0, filterParams = '&brand=bambu') => (
  <RevenueMovers granularity="month" bucketKey="2026-11" bucketLabel="nov. 2026" filterParams={filterParams} version={version} today="2026-11-19" />
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

  it('shows the failure of the latest request instead of the previous rows', async () => {
    const fetchMock = vi.fn(async (u: string) =>
      u.includes('kind=goods') ? new Response(JSON.stringify({ detail: 'movers unavailable' }), { status: 500, headers: { 'Content-Type': 'application/json' } }) : json(payload()),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { rerender } = render(renderMovers(0));
    await screen.findByText('Printer X1');
    rerender(renderMovers(0, '&kind=goods'));
    expect(await screen.findByText('movers unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Printer X1')).toBeNull();
  });

  it('prefills the comparison from the period payload, never from a stale comparison', async () => {
    let releaseDefault: (() => void) | null = null;
    let defaultCalls = 0;
    const fetchMock = vi.fn(async (u: string) => {
      if (u.includes('cfrom=')) return json(payload({ granularity: null, key: null, current: { from: '2026-01-01', to: '2026-01-31' }, previous: { from: '2025-01-01', to: '2025-01-31' } }));
      defaultCalls += 1;
      if (defaultCalls > 1) await new Promise<void>((r) => { releaseDefault = r; });
      return json(payload());
    });
    vi.stubGlobal('fetch', fetchMock);
    render(renderMovers());
    await screen.findByText('Printer X1');
    fireEvent.click(screen.getByRole('button', { name: '⇄ Compare two periods' }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('cfrom='))).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    fireEvent.click(screen.getByRole('button', { name: '← Period movements' }));
    // The comparison payload is still on screen while the period reloads: compare stays unavailable.
    expect(screen.getByRole('button', { name: '⇄ Compare two periods' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '⇄ Compare two periods' }));
    expect(screen.queryByLabelText('Period A, start')).toBeNull();
    await waitFor(() => expect(releaseDefault).not.toBeNull());
    releaseDefault!();
    await waitFor(() => expect(screen.getByRole('button', { name: '⇄ Compare two periods' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '⇄ Compare two periods' }));
    expect(screen.getByLabelText('Period A, start')).toHaveValue('2026-11-01');
    expect(screen.getByLabelText('Period A, end')).toHaveValue('2026-11-19');
    expect(screen.getByLabelText('Period B, start')).toHaveValue('2026-10-01');
    expect(screen.getByLabelText('Period B, end')).toHaveValue('2026-10-19');
  });
});
