/**
 * useOpenOrders: the open-order list plus the derived `noOrderNeeded` flag that
 * lets PrintRevisionFlow and ResliceDialog skip the order picker.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { server } from '../../../mocks/server';
import { wrapper } from '../../../utils';
import { useOpenOrders } from '../../../../components/projects/print/useOpenOrders';

// null = real AuthProvider (auth disabled: every permission granted).
let granted: Set<string> | null = null;
vi.mock('../../../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../contexts/AuthContext')>();
  return {
    ...actual,
    useAuth: () => {
      const real = actual.useAuth();
      return granted ? { ...real, hasPermission: (p: string) => granted!.has(p) } : real;
    },
  };
});

const order = (task_id: number, board_column: string) => ({ task_id, board_column });

beforeEach(() => {
  granted = null;
});

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
    const { result } = renderHook(() => useOpenOrders(7), { wrapper });
    expect(result.current).toMatchObject({ openOrders: [], loading: false, failed: false, noOrderNeeded: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(gets).toBe(0);
  });
});
