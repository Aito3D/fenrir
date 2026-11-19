import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useRevenueResource } from '../../../components/revenue/useRevenueResource';

const json = (body: unknown, etag?: string) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', ...(etag ? { ETag: etag } : {}) } });

afterEach(() => vi.unstubAllGlobals());

describe('useRevenueResource', () => {
  it('fetches nothing for a null url', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useRevenueResource(null, 0));
    expect(result.current).toMatchObject({ data: null, error: null, loading: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('revalidates with If-None-Match and keeps the data on 304', async () => {
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) =>
      (init.headers as Record<string, string>)['If-None-Match'] ? new Response(null, { status: 304 }) : json({ n: 1 }, '"abc"'),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result, rerender } = renderHook(({ v }) => useRevenueResource<{ n: number }>('/api/v1/revenue/yoy', v), { initialProps: { v: 0 } });
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
    rerender({ v: 1 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect((fetchMock.mock.calls[1][1].headers as Record<string, string>)['If-None-Match']).toBe('"abc"');
    expect(result.current).toMatchObject({ data: { n: 1 }, loading: false, error: null });
  });

  it('keeps the previous data while a new url loads and drops an overtaken answer', async () => {
    const pending: Record<string, (r: Response) => void> = {};
    vi.stubGlobal('fetch', vi.fn((u: string) => new Promise<Response>((resolve) => (pending[u] = resolve))));
    const { result, rerender } = renderHook(({ url }) => useRevenueResource<{ u: string }>(url, 0), { initialProps: { url: '/a' } });
    await act(async () => pending['/a'](json({ u: 'a' })));
    await waitFor(() => expect(result.current.data).toEqual({ u: 'a' }));
    rerender({ url: '/b' });
    expect(result.current).toMatchObject({ data: { u: 'a' }, loading: true });
    rerender({ url: '/c' });
    await act(async () => pending['/c'](json({ u: 'c' })));
    await waitFor(() => expect(result.current.data).toEqual({ u: 'c' }));
    await act(async () => pending['/b'](json({ u: 'b' })));
    expect(result.current).toMatchObject({ data: { u: 'c' }, loading: false });
  });

  it('reports the failure detail and reloads on demand', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'nope' }), { status: 500 }))
      .mockResolvedValueOnce(json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useRevenueResource<{ ok: boolean }>('/x', 0));
    await waitFor(() => expect(result.current.error).toBe('nope'));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.data).toEqual({ ok: true }));
    expect(result.current.error).toBeNull();
  });
});
