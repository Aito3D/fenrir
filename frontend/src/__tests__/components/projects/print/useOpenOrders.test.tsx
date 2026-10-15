/**
 * useOpenOrders: the open-order list plus the derived `noOrderNeeded` flag that
 * lets PrintRevisionFlow and ResliceDialog skip the order picker.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { server } from '../../../mocks/server';
import { wrapper } from '../../../utils';
import { useOpenOrders } from '../../../../components/projects/print/useOpenOrders';
import { api } from '../../../../api/client';

// null = real AuthProvider (auth disabled: every permission granted).
let granted: Set<string> | null = null;
vi.mock('../../../../contexts/AuthContext', async (importOriginal) => {
  const { withGrantedPermissions } = await import('../../../fixtures/authPermissions');
  return withGrantedPermissions(await importOriginal<typeof import('../../../../contexts/AuthContext')>(), () => granted);
});

const order = (task_id: number, board_column: string) => ({ task_id, board_column });

beforeEach(() => {
  granted = null;
});

afterEach(() => vi.restoreAllMocks());

describe('useOpenOrders', () => {
  it('no open order (only done ones) and loaded fine: noOrderNeeded', async () => {
    server.use(http.get('/api/v1/projects/7/orders', () => HttpResponse.json({ orders: [order(1, 'done')] })));
    const { result } = renderHook(() => useOpenOrders(7), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({ openOrders: [], failed: false, noOrderNeeded: true });
  });

  it('an open order present: picker needed', async () => {
    server.use(http.get('/api/v1/projects/7/orders', () => HttpResponse.json({ orders: [order(1, 'print'), order(2, 'done')] })));
    const { result } = renderHook(() => useOpenOrders(7), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.openOrders.map((o) => o.task_id)).toEqual([1]);
    expect(result.current.noOrderNeeded).toBe(false);
  });

  it('while loading: picker needed', async () => {
    server.use(http.get('/api/v1/projects/7/orders', async () => {
      await delay('infinite');
      return HttpResponse.json({ orders: [] });
    }));
    const { result } = renderHook(() => useOpenOrders(7), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current).toMatchObject({ openOrders: [], failed: false, noOrderNeeded: false });
  });

  it('orders failed to load: picker needed', async () => {
    server.use(http.get('/api/v1/projects/7/orders', () => HttpResponse.json({ detail: 'boom' }, { status: 500 })));
    const { result } = renderHook(() => useOpenOrders(7), { wrapper });
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current).toMatchObject({ openOrders: [], loading: false, noOrderNeeded: false });
  });

  it('without aito:read the query is disabled: not loading, not failed, noOrderNeeded', async () => {
    let gets = 0;
    server.use(http.get('/api/v1/projects/7/orders', () => { gets += 1; return HttpResponse.json({ orders: [order(1, 'print')] }); }));
    granted = new Set(['projects:read']);
    const fetchOrders = vi.spyOn(api, 'getProjectOrders');
    const { result, rerender } = renderHook(() => useOpenOrders(7), { wrapper });
    expect(result.current).toMatchObject({ openOrders: [], loading: false, failed: false, noOrderNeeded: true });
    // An enabled query calls its fetcher on mount (inside renderHook's act): the spy is decisive.
    await act(async () => {});
    expect(fetchOrders).not.toHaveBeenCalled();
    expect(gets).toBe(0);
    // Positive control: with aito:read the same hook fetches through the same spy.
    granted = new Set(['projects:read', 'aito:read']);
    rerender();
    await waitFor(() => expect(gets).toBe(1));
    expect(fetchOrders).toHaveBeenCalledTimes(1);
  });
});
