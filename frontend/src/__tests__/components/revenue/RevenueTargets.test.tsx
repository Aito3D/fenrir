import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '../../../contexts/ToastContext';
import { setAuthToken } from '../../../api/client';
import { RevenueTargets } from '../../../components/revenue/RevenueTargets';
import type { TargetsResponse } from '../../../components/revenue/lib/types';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const G = new Intl.NumberFormat('fr-FR');
const saved: TargetsResponse = {
  targets: [
    { month: '2026-01', amountHt: 1_500_000, updatedAt: '2026-01-01T00:00:00Z' },
    { month: '2026-03', amountHt: 2_000_000, updatedAt: '2026-01-01T00:00:00Z' },
  ],
};

type Write = (url: string, init: RequestInit) => Promise<Response> | Response;

function setup(o: { canManage?: boolean; write?: Write; actualByMonth?: Record<string, number> | null } = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (!init?.method) return json(saved);
    if (o.write) return o.write(url, init);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    return json(body ? { target: { month: url.slice(-7), amountHt: body.amountHt, updatedAt: 'x' } } : { cleared: true });
  });
  vi.stubGlobal('fetch', fetchMock);
  const onChanged = vi.fn();
  const onClose = vi.fn();
  render(
    <ToastProvider>
      <RevenueTargets canManage={o.canManage ?? true} onChanged={onChanged} onClose={onClose} today="2026-11-19"
        actualByMonth={o.actualByMonth === undefined ? null : o.actualByMonth} />
    </ToastProvider>,
  );
  const writes = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method) as unknown as [string, RequestInit][];
  return { fetchMock, onChanged, onClose, writes };
}

const input = (month: string) => screen.getByRole('textbox', { name: `Target ${month} 2026` }) as HTMLInputElement;

afterEach(() => {
  vi.unstubAllGlobals();
  setAuthToken(null);
});

describe('RevenueTargets', () => {
  it('loads the saved targets, grouped, one row per month', async () => {
    setAuthToken('tok');
    const { fetchMock } = setup();
    await waitFor(() => expect(input('January').value).toBe(G.format(1_500_000)));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/revenue/targets');
    expect(((fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(input('February').value).toBe('');
    expect(screen.getAllByRole('textbox')).toHaveLength(12);
  });

  it('steps the year within the org year ±1', async () => {
    setup();
    await waitFor(() => expect(input('January').value).not.toBe(''));
    const prev = screen.getByRole('button', { name: 'Previous year' });
    const next = screen.getByRole('button', { name: 'Next year' });
    fireEvent.click(prev);
    expect(screen.getByText('2025')).toBeInTheDocument();
    expect(prev).toBeDisabled();
    fireEvent.click(next);
    fireEvent.click(next);
    expect(screen.getByText('2027')).toBeInTheDocument();
    expect(next).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Target January 2027' })).toHaveValue('');
  });

  it('keeps digits only and shows them grouped', async () => {
    setup();
    await waitFor(() => expect(input('January').value).not.toBe(''));
    fireEvent.change(input('February'), { target: { value: '1 25a0 000 FCP' } });
    expect(input('February').value).toBe(G.format(1_250_000));
  });

  it('saves a row on Enter as a plain integer, then reloads the page', async () => {
    setAuthToken('tok');
    const { writes, onChanged } = setup();
    await waitFor(() => expect(input('January').value).not.toBe(''));
    fireEvent.change(input('February'), { target: { value: '1 250 000' } });
    fireEvent.keyDown(input('February'), { key: 'Enter' });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    const [url, init] = writes()[0];
    expect(url).toBe('/api/v1/revenue/targets/2026-02');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ amountHt: 1_250_000 });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(await screen.findByText('Target 2026-02 saved.')).toBeInTheDocument();
    expect(input('February').value).toBe(G.format(1_250_000));
  });

  it('deletes a target whose input is emptied', async () => {
    const { writes, onChanged } = setup();
    await waitFor(() => expect(input('January').value).not.toBe(''));
    fireEvent.change(input('January'), { target: { value: '' } });
    fireEvent.keyDown(input('January'), { key: 'Enter' });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(writes()[0][0]).toBe('/api/v1/revenue/targets/2026-01');
    expect(writes()[0][1].method).toBe('DELETE');
    expect(input('January').value).toBe('');
  });

  it('refuses an amount above 10^12 before sending it', async () => {
    const { writes } = setup();
    await waitFor(() => expect(input('January').value).not.toBe(''));
    fireEvent.change(input('February'), { target: { value: '1000000000001' } });
    expect(input('February')).toHaveAttribute('aria-invalid', 'true');
    fireEvent.keyDown(input('February'), { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Save all (1)' })).toBeDisabled();
    expect(writes()).toHaveLength(0);
    fireEvent.change(input('February'), { target: { value: '1000000000000' } });
    expect(input('February')).not.toHaveAttribute('aria-invalid');
  });

  it('sends one request for a double Enter', async () => {
    let answer: (r: Response) => void = () => {};
    const { writes } = setup({ write: () => new Promise<Response>((r) => (answer = r)) });
    await waitFor(() => expect(input('January').value).not.toBe(''));
    fireEvent.change(input('February'), { target: { value: '5' } });
    fireEvent.keyDown(input('February'), { key: 'Enter' });
    fireEvent.keyDown(input('February'), { key: 'Enter' });
    expect(writes()).toHaveLength(1);
    answer(json({ target: { month: '2026-02', amountHt: 5, updatedAt: 'x' } }));
  });

  it('shows the server detail when a row fails and keeps its draft', async () => {
    const { onChanged } = setup({ write: () => json({ detail: 'amountHt must be a number between 0 and 10^12' }, 422) });
    await waitFor(() => expect(input('January').value).not.toBe(''));
    fireEvent.change(input('February'), { target: { value: '7' } });
    fireEvent.keyDown(input('February'), { key: 'Enter' });
    expect(await screen.findByText('Target 2026-02: amountHt must be a number between 0 and 10^12')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
    expect(input('February').value).toBe('7');
  });

  it('copies the first filled month into the empty drafts only', async () => {
    setup();
    await waitFor(() => expect(input('January').value).not.toBe(''));
    fireEvent.click(screen.getByRole('button', { name: 'Copy across the year' }));
    expect(input('February').value).toBe(G.format(1_500_000));
    expect(input('March').value).toBe(G.format(2_000_000));
    expect(input('December').value).toBe(G.format(1_500_000));
    expect(screen.getByRole('button', { name: 'Save all (10)' })).toBeEnabled();
  });

  it('saves every changed row one after the other', async () => {
    const order: string[] = [];
    let open = 0;
    let overlap = false;
    const { onChanged } = setup({
      write: async (url, init) => {
        if (open++ > 0) overlap = true;
        order.push(url.slice(-7));
        await Promise.resolve();
        open--;
        return json({ target: { month: url.slice(-7), amountHt: JSON.parse(String(init.body)).amountHt, updatedAt: 'x' } });
      },
    });
    await waitFor(() => expect(input('January').value).not.toBe(''));
    fireEvent.change(input('February'), { target: { value: '10' } });
    fireEvent.change(input('April'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save all (2)' }));
    expect(await screen.findByText('Targets saved: 2')).toBeInTheDocument();
    expect(order).toEqual(['2026-02', '2026-04']);
    expect(overlap).toBe(false);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Save all' })).toBeDisabled();
  });

  it('reports a partial failure with the count and the server message, keeping the unsaved drafts', async () => {
    let n = 0;
    const { onChanged } = setup({
      write: (url, init) =>
        ++n === 3 ? json({ detail: 'database is locked' }, 503) : json({ target: { month: url.slice(-7), amountHt: JSON.parse(String(init.body)).amountHt, updatedAt: 'x' } }),
    });
    await waitFor(() => expect(input('January').value).not.toBe(''));
    for (const [m, v] of [['February', '1'], ['April', '2'], ['May', '3'], ['June', '4'], ['July', '5']]) fireEvent.change(input(m), { target: { value: v } });
    fireEvent.click(screen.getByRole('button', { name: 'Save all (5)' }));
    expect(await screen.findByText('2/5 saved — database is locked')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Save all (3)' })).toBeEnabled();
    expect(input('May').value).toBe('3');
    expect(input('July').value).toBe('5');
  });

  it('shows Actual HT and the share reached only on the unfiltered month view', async () => {
    setup({ actualByMonth: { '2026-01': 1_650_000 } });
    await waitFor(() => expect(input('January').value).not.toBe(''));
    expect(screen.getByRole('columnheader', { name: 'Actual HT' })).toBeInTheDocument();
    const jan = input('January').closest('tr')!;
    expect(within(jan).getByText('1.650.000 FCP')).toBeInTheDocument();
    expect(within(jan).getByText('110 %')).toBeInTheDocument();
  });

  it('has no Actual HT column off the unfiltered month view', async () => {
    setup({ actualByMonth: null });
    await waitFor(() => expect(input('January').value).not.toBe(''));
    expect(screen.queryByRole('columnheader', { name: 'Actual HT' })).toBeNull();
  });

  it('shows the targets read-only without revenue:manage_targets', async () => {
    setup({ canManage: false });
    // Text matching collapses the narrow no-break space of fr-FR grouping to a plain space.
    expect(await screen.findByText(G.format(1_500_000).replace(/\s/g, ' '))).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Save/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy across the year' })).toBeNull();
  });

  it('takes focus when it opens and closes from its own button', () => {
    const { onClose } = setup();
    const panel = screen.getByRole('region', { name: 'Monthly HT targets' });
    expect(within(panel).getByRole('heading', { name: 'Monthly HT targets' })).toHaveFocus();
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
