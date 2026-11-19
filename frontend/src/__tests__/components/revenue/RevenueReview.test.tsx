import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '../../../contexts/ToastContext';
import { setAuthToken } from '../../../api/client';
import { RevenueReview } from '../../../components/revenue/RevenueReview';
import type { ReviewResponse } from '../../../components/revenue/lib/types';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const review: ReviewResponse = {
  unclassified: [{ itemId: 'a/1', name: 'Filament mystère', sku: 'X1', totalHt: 12_000, quantity: 2, lastDay: '2026-10-02', brand: 'Acme', nature: null }],
  decided: [{ itemId: 'b2', name: 'Vis M3', sku: 'V3', totalHt: 800, quantity: 10, lastDay: '2026-09-01', brand: null, nature: 'Visserie', included: true }],
};

function setup(o: { canManage?: boolean; write?: (url: string, init: RequestInit) => Promise<Response | null> | Response | null; body?: ReviewResponse } = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (!init?.method) return json(o.body ?? review);
    const r = o.write ? await o.write(url, init) : json({ ok: true });
    if (!r) throw new TypeError('Failed to fetch');
    return r;
  });
  vi.stubGlobal('fetch', fetchMock);
  const onChanged = vi.fn();
  const onClose = vi.fn();
  render(
    <ToastProvider>
      <RevenueReview canManage={o.canManage ?? true} onChanged={onChanged} onClose={onClose} />
    </ToastProvider>,
  );
  const writes = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method) as unknown as [string, RequestInit][];
  const reads = () => fetchMock.mock.calls.filter(([, init]) => !(init as RequestInit | undefined)?.method);
  return { fetchMock, onChanged, onClose, writes, reads };
}

afterEach(() => {
  vi.unstubAllGlobals();
  setAuthToken(null);
});

describe('RevenueReview', () => {
  it('lists the unclassified items, and the decided ones on demand', async () => {
    setAuthToken('tok');
    const { fetchMock } = setup();
    const row = (await screen.findByText('Filament mystère')).closest('li')!;
    expect(row).toHaveTextContent('Acme · — · last 2026-10-02');
    expect(row).toHaveTextContent('12.000 FCP');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/revenue/review');
    expect(((fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(screen.queryByText('Vis M3')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Decisions (1)' }));
    const decided = screen.getByText('Vis M3').closest('li')!;
    expect(decided).toHaveTextContent('Included');
    expect(screen.getByRole('button', { name: 'Hide decisions' })).toBeInTheDocument();
  });

  it('says when nothing is left to classify', async () => {
    setup({ body: { unclassified: [], decided: [] } });
    expect(await screen.findByText('Nothing to classify.')).toBeInTheDocument();
  });

  it('hides Include, Exclude and Undo without revenue:manage_scope, the lists stay', async () => {
    setup({ canManage: false });
    await screen.findByText('Filament mystère');
    fireEvent.click(screen.getByRole('button', { name: 'Decisions (1)' }));
    expect(screen.getByText('Vis M3')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Include' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Exclude' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('includes an item with its id escaped, then reloads the list and the page', async () => {
    setAuthToken('tok');
    const { writes, reads, onChanged } = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Include' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    const [url, init] = writes()[0];
    expect(url).toBe('/api/v1/revenue/scope/a%2F1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ included: true });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(reads()).toHaveLength(2);
  });

  it('excludes an item', async () => {
    const { writes, onChanged } = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Exclude' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(JSON.parse(String(writes()[0][1].body))).toEqual({ included: false });
  });

  it('undoes a decision with DELETE', async () => {
    const { writes, onChanged } = setup();
    await screen.findByText('Filament mystère');
    fireEvent.click(screen.getByRole('button', { name: 'Decisions (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(writes()[0][0]).toBe('/api/v1/revenue/scope/b2');
    expect(writes()[0][1].method).toBe('DELETE');
  });

  it('sends one request for a double click', async () => {
    let answer: (r: Response) => void = () => {};
    const { writes } = setup({ write: () => new Promise<Response>((r) => (answer = r)) });
    const include = await screen.findByRole('button', { name: 'Include' });
    fireEvent.click(include);
    fireEvent.click(include);
    expect(writes()).toHaveLength(1);
    answer(json({ ok: true }));
  });

  it('shows the server detail and reloads nothing when a decision fails', async () => {
    const { onChanged, reads } = setup({ write: () => json({ detail: 'item id is not valid' }, 422) });
    fireEvent.click(await screen.findByRole('button', { name: 'Include' }));
    expect(await screen.findByText('item id is not valid')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
    expect(reads()).toHaveLength(1);
  });

  it('says the change was not saved when the request never reaches the server', async () => {
    setup({ write: () => null });
    fireEvent.click(await screen.findByRole('button', { name: 'Include' }));
    expect(await screen.findByText('Change not saved')).toBeInTheDocument();
  });

  it('shows the error of the list load', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ detail: 'Zoho is down' }, 502)));
    render(
      <ToastProvider>
        <RevenueReview canManage onChanged={vi.fn()} onClose={vi.fn()} />
      </ToastProvider>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Zoho is down');
  });

  it('takes focus when it opens and closes from its own button', async () => {
    const { onClose } = setup();
    const panel = screen.getByRole('region', { name: 'To classify' });
    expect(within(panel).getByRole('heading', { name: 'To classify' })).toHaveFocus();
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await screen.findByText('Filament mystère');
  });
});
