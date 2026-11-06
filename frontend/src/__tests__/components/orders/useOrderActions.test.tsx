/** The write actions of an order: the answer's board replaces the list, the sheet fetcher refetches it. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { server } from '../../mocks/server';
import type { OrderBoardResponse } from '../../../api/client';
import { useOrderActions } from '../../../components/orders/useOrderActions';

vi.mock('../../../contexts/AuthContext', () => ({ useAuth: () => ({ hasPermission: () => true }) }));

const board = { rows: [], computed_at: '2026-11-06T10:00:00', stock_loaded_at: '2026-11-06T10:00:00', sync: {} } as unknown as OrderBoardResponse;
const outcome = { package_number: 'PKG-1', shipment: 'created', delivered: 'done', invoice: 'created', invoice_number: 'FAC-1', manual_reason: null, credit_applied: 0, failed_step: null, error: null };

const setup = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, ...renderHook(() => useOrderActions(), { wrapper }) };
};

afterEach(() => server.resetHandlers());

describe('useOrderActions', () => {
  it('a hand-over puts the returned board into the list and returns the outcome', async () => {
    server.use(http.post('*/order-board/orders/so1/packages/p1/handover', async ({ request }) => {
      expect(await request.json()).toEqual({ mode: 'pickup', apply_credit: true });
      return HttpResponse.json({ board, outcome });
    }));
    const { client, result } = setup();
    let answer: Awaited<ReturnType<typeof result.current.handOver.mutateAsync>> | undefined;
    await act(async () => {
      answer = await result.current.handOver.mutateAsync({ id: 'so1', packageId: 'p1', mode: 'pickup', applyCredit: true });
    });
    expect(answer?.outcome.invoice_number).toBe('FAC-1');
    expect(client.getQueryData(['order-board'])).toEqual(board);
  });

  it('a failed call is thrown to the caller and leaves the list alone', async () => {
    server.use(http.post('*/order-board/orders/so1/invoice', () => HttpResponse.json({ detail: 'too_many' }, { status: 400 })));
    const { client, result } = setup();
    await act(async () => {
      await expect(result.current.createInvoice.mutateAsync({ id: 'so1', applyCredit: false })).rejects.toThrow();
    });
    expect(client.getQueryData(['order-board'])).toBeUndefined();
  });

  it('the callbacks of a hand-over and of an invoice run with the answer or the error', async () => {
    server.use(
      http.post('*/order-board/orders/so1/packages/p1/handover', () => HttpResponse.json({ board, outcome })),
      http.post('*/order-board/orders/so1/invoice', () => HttpResponse.json({ detail: 'x' }, { status: 503 })),
    );
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const done = vi.fn();
    const failed = vi.fn();
    const { result } = renderHook(() => useOrderActions({ handOver: { onSuccess: done }, invoice: { onError: failed } }), { wrapper });
    await act(async () => {
      await result.current.handOver.mutateAsync({ id: 'so1', packageId: 'p1', mode: 'delivery', applyCredit: false });
      await result.current.createInvoice.mutateAsync({ id: 'so1', applyCredit: true }).catch(() => undefined);
    });
    expect(done).toHaveBeenCalledWith({ board, outcome }, { id: 'so1', packageId: 'p1', mode: 'delivery', applyCredit: false });
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it('the sheet fetcher returns the PDF and refetches the board once printed', async () => {
    server.use(http.post('*/order-board/orders/so1/prep-sheet', () => new HttpResponse(new Blob(['%PDF-']), { headers: { 'Content-Type': 'application/pdf' } })));
    const { client, result } = setup();
    client.setQueryData(['order-board'], board);
    expect(result.current.canUpdate).toBe(true);
    const blob = await result.current.printSheet('so1')();
    expect(blob.size).toBeGreaterThan(0);
    await waitFor(() => expect(client.getQueryState(['order-board'])?.isInvalidated).toBe(true));
  });

  it('a board poll in flight when the answer lands does not put the old board back', async () => {
    server.use(http.post('*/order-board/orders/so1/packages/p1/handover', () => HttpResponse.json({ board, outcome })));
    const { client, result } = setup();
    const old = { ...board, computed_at: 'old' } as OrderBoardResponse;
    void client.fetchQuery({ queryKey: ['order-board'], queryFn: () => new Promise<OrderBoardResponse>(r => setTimeout(() => r(old), 200)) }).catch(() => undefined); // cancelled by the answer
    await act(async () => {
      await result.current.handOver.mutateAsync({ id: 'so1', packageId: 'p1', mode: 'pickup', applyCredit: false });
    });
    await new Promise(r => setTimeout(r, 300));
    expect(client.getQueryData(['order-board'])).toEqual(board);
  });
});
