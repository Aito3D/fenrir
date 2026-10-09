/**
 * projectQueries: the shared project-tree / project-orders keys and the two read
 * hooks, which keep each caller's own options on top of the key + fetcher.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../../../api/client';
import { projectKeys, useProjectOrders, useProjectTree } from '../../../components/projects/projectQueries';

const tree = { project_id: 7, code: 'P-0007', sections: [] };
const orders = { orders: [] };

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

afterEach(() => vi.restoreAllMocks());

describe('projectKeys', () => {
  it('builds the exact key arrays the cache and invalidations use', () => {
    expect(projectKeys.tree(7)).toEqual(['project-tree', 7]);
    expect(projectKeys.orders(7)).toEqual(['project-orders', 7]);
    expect(projectKeys.tree(undefined)).toEqual(['project-tree', undefined]);
    expect(projectKeys.orders(undefined)).toEqual(['project-orders', undefined]);
    expect(projectKeys.tree(7)).toHaveLength(2);
  });
});

describe('useProjectTree', () => {
  it('fetches the tree under ["project-tree", id]', async () => {
    const spy = vi.spyOn(api, 'getProjectTree').mockResolvedValue(tree as never);
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useProjectTree(7), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(tree));
    expect(spy).toHaveBeenCalledWith(7);
    expect(client.getQueryCache().findAll().map((q) => q.queryKey)).toEqual([['project-tree', 7]]);
  });

  it('enabled:false from the caller suppresses the fetch', async () => {
    const spy = vi.spyOn(api, 'getProjectTree').mockResolvedValue(tree as never);
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useProjectTree(undefined, { enabled: false }), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe('idle');
    expect(client.getQueryCache().findAll().map((q) => q.queryKey)).toEqual([['project-tree', undefined]]);
  });

  it('caller options override the client defaults (retry:false fails on the first error)', async () => {
    const spy = vi.spyOn(api, 'getProjectTree').mockRejectedValue(new Error('boom'));
    const { client, wrapper } = setup();
    client.setDefaultOptions({ queries: { retry: 3, retryDelay: 0 } });
    const { result } = renderHook(() => useProjectTree(7, { retry: false }), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('useProjectOrders', () => {
  it('fetches the orders under ["project-orders", id]', async () => {
    const spy = vi.spyOn(api, 'getProjectOrders').mockResolvedValue(orders as never);
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useProjectOrders(7, { retry: false }), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(orders));
    expect(spy).toHaveBeenCalledWith(7);
    expect(client.getQueryCache().findAll().map((q) => q.queryKey)).toEqual([['project-orders', 7]]);
  });

  it('enabled:false from the caller suppresses the fetch', async () => {
    const spy = vi.spyOn(api, 'getProjectOrders').mockResolvedValue(orders as never);
    const { wrapper } = setup();
    const { result } = renderHook(() => useProjectOrders(7, { enabled: false }), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe('idle');
  });
});
