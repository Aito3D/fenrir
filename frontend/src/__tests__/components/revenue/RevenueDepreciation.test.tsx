import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '../../../contexts/ToastContext';
import { RevenueDepreciation } from '../../../components/revenue/RevenueDepreciation';
import type { DepreciationAsset, DepreciationState } from '../../../components/revenue/lib/types';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const asset = (id: string, o: Partial<DepreciationAsset> = {}): DepreciationAsset => ({
  id, number: `IMMO-${id}`, name: `Asset ${id}`, type: 'Machine 3D', cost: 360_000, start: '2020-01-01', months: 1200, status: 'active', ...o,
});
const ASSETS = [asset('a1'), asset('a2'), asset('a3', { type: 'Ordinateur', name: 'Scan 3D' })];
const state = (assets = ASSETS, selected: string[] = []): DepreciationState => ({ assets, selected, readAt: '2026-11-25T10:00:00+00:00' });

function setup({ stored = state(), refresh = () => json(state()), canManage = true }: {
  stored?: DepreciationState; refresh?: () => Response; canManage?: boolean;
} = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/refresh')) return refresh();
    if (init?.method === 'PUT') return json({ ...stored, selected: JSON.parse(String(init.body)).selected });
    return json(stored);
  });
  vi.stubGlobal('fetch', fetchMock);
  const onChanged = vi.fn();
  render(
    <ToastProvider>
      <RevenueDepreciation canManage={canManage} onChanged={onChanged} />
    </ToastProvider>,
  );
  return { fetchMock, onChanged };
}
const calls = (fetchMock: ReturnType<typeof vi.fn>, method: string) => fetchMock.mock.calls.filter(([, init]) => (init?.method ?? 'GET') === method);

afterEach(() => vi.unstubAllGlobals());

describe('RevenueDepreciation', () => {
  it('groups the assets by Zoho type, with nothing switched on', async () => {
    setup();
    expect(await screen.findByRole('switch', { name: 'Machine 3D (2)' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('switch', { name: 'Ordinateur (1)' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Scan 3D' })).toHaveAttribute('aria-checked', 'false');
    // 360 000 over 1 200 months.
    expect(screen.getAllByText('300 FCP')).toHaveLength(3);
  });

  it('saves the ids of a whole type switched on at once', async () => {
    const { fetchMock, onChanged } = setup();
    fireEvent.click(await screen.findByRole('switch', { name: 'Machine 3D (2)' }));
    expect(screen.getByRole('switch', { name: 'Asset a1' })).toHaveAttribute('aria-checked', 'true');
    // Two assets of 300 a month.
    expect(screen.getByText('600 FCP')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [url, init] = calls(fetchMock, 'PUT')[0];
    expect(url).toBe('/api/v1/revenue/depreciation');
    expect(JSON.parse(String(init!.body))).toEqual({ selected: ['a1', 'a2'] });
  });

  it('reads Zoho once on its own when nothing is stored yet, and not otherwise', async () => {
    const empty = setup({ stored: { assets: [], selected: [], readAt: null } });
    await screen.findByRole('switch', { name: 'Scan 3D' });
    expect(calls(empty.fetchMock, 'POST')).toHaveLength(1);
    vi.unstubAllGlobals();
    const filled = setup();
    await screen.findAllByRole('switch', { name: 'Scan 3D' });
    expect(calls(filled.fetchMock, 'POST')).toHaveLength(0);
  });

  it('keeps the rows and offers a retry when Zoho cannot be read', async () => {
    setup({ refresh: () => json({ detail: 'Zoho could not be read' }, 502) });
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh from Zoho' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Zoho could not be read');
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Scan 3D' })).toBeInTheDocument();
  });

  it('is read-only without the manage right', async () => {
    const { fetchMock } = setup({ canManage: false, stored: state(ASSETS, ['a1']) });
    expect(await screen.findByRole('switch', { name: 'Asset a1' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh from Zoho' })).toBeNull();
    expect(calls(fetchMock, 'POST')).toHaveLength(0);
  });

  it('lists an asset Zoho no longer calls active, without counting it', async () => {
    setup({ stored: state([asset('a1'), asset('a2', { status: 'sold' })], ['a1', 'a2']) });
    expect(await screen.findByRole('switch', { name: 'Asset a2' })).toBeDisabled();
    expect(screen.getByText('no longer active')).toBeInTheDocument();
    // The type's monthly figure is a1 alone; its own row shows it too.
    expect(screen.getAllByText('300 FCP')).toHaveLength(2);
    expect(screen.queryByText('600 FCP')).toBeNull();
  });
});
