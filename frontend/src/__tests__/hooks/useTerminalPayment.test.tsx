import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { isTerminalOpen, TERMINAL_POLL_MS, useTerminalPayment } from '../../components/aito/payment/useTerminalPayment';
import { api } from '../../api/client';
import type { AitoTerminalPayment } from '../../api/client';

vi.mock('../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../api/client')>('../../api/client');
  return { ...actual, api: { ...actual.api, getAitoTerminalPayment: vi.fn() } };
});

const tpe = (o: Partial<AitoTerminalPayment> = {}): AitoTerminalPayment => ({
  id: 7, document_kind: 'invoice', document_number: 'FA-26-0001', status: 'processing', amount: 23000, amount_confirmed: null,
  booking_status: 'pending', booking_error: null, sync_error: null, created_at: '2026-09-23T01:00:00', settled_at: null, ...o,
});

const QUERY_KEY = ['aito-terminal-payment', 12, 7];

describe('isTerminalOpen', () => {
  it('is false for null/undefined — nothing started yet', () => {
    expect(isTerminalOpen(null)).toBe(false);
    expect(isTerminalOpen(undefined)).toBe(false);
  });

  it('is true while the operator is waiting on the card (pending/processing)', () => {
    expect(isTerminalOpen(tpe({ status: 'pending' }))).toBe(true);
    expect(isTerminalOpen(tpe({ status: 'processing' }))).toBe(true);
  });

  it('is true once paid but Zoho Books has not recorded it yet', () => {
    expect(isTerminalOpen(tpe({ status: 'paid', booking_status: 'pending' }))).toBe(true);
  });

  it('is false once paid and booked, or paid but the booking failed/was never attempted', () => {
    expect(isTerminalOpen(tpe({ status: 'paid', booking_status: 'booked' }))).toBe(false);
    expect(isTerminalOpen(tpe({ status: 'paid', booking_status: 'failed' }))).toBe(false);
    expect(isTerminalOpen(tpe({ status: 'paid', booking_status: 'not_booked' }))).toBe(false);
    expect(isTerminalOpen(tpe({ status: 'paid', booking_status: null }))).toBe(false);
  });

  it('is false for every other terminal state', () => {
    expect(isTerminalOpen(tpe({ status: 'failed' }))).toBe(false);
    expect(isTerminalOpen(tpe({ status: 'cancelled' }))).toBe(false);
    expect(isTerminalOpen(tpe({ status: 'expired' }))).toBe(false);
    expect(isTerminalOpen(tpe({ status: 'needs_attention' }))).toBe(false);
  });
});

describe('useTerminalPayment', () => {
  let client: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) => {
    // Deliberately no `retry: false` in these defaults, unlike the shared
    // test render() wrapper (src/__tests__/utils.tsx) — the point of the
    // retry test below is to pin that the hook's OWN `retry: false` is
    // what stops internal retries, not an artifact of the test harness.
    client = new QueryClient();
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };

  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => { vi.useRealTimers(); vi.mocked(api.getAitoTerminalPayment).mockReset(); });

  it('polls every TERMINAL_POLL_MS while the status stays open, and stops once it settles', async () => {
    const get = vi.mocked(api.getAitoTerminalPayment)
      .mockResolvedValueOnce(tpe({ status: 'pending' }))
      .mockResolvedValueOnce(tpe({ status: 'processing' }))
      .mockResolvedValueOnce(tpe({ status: 'paid', booking_status: 'pending' }))
      .mockResolvedValue(tpe({ status: 'paid', booking_status: 'booked' }));

    const { result } = renderHook(() => useTerminalPayment(12, 7, null), { wrapper });

    await waitFor(() => expect(result.current.data?.status).toBe('pending'));
    expect(get).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(TERMINAL_POLL_MS + 100); });
    expect(get).toHaveBeenCalledTimes(2);
    expect(result.current.data?.status).toBe('processing');

    await act(async () => { await vi.advanceTimersByTimeAsync(TERMINAL_POLL_MS + 100); });
    expect(get).toHaveBeenCalledTimes(3);
    expect(result.current.data?.booking_status).toBe('pending');

    // Still open (paid, booking pending) — one more tick moves it to booked.
    await act(async () => { await vi.advanceTimersByTimeAsync(TERMINAL_POLL_MS + 100); });
    expect(get).toHaveBeenCalledTimes(4);
    expect(result.current.data?.booking_status).toBe('booked');

    // Settled: `refetchInterval` must now return `false`, so further
    // elapsed time must not produce any more calls.
    await act(async () => { await vi.advanceTimersByTimeAsync(TERMINAL_POLL_MS * 3); });
    expect(get).toHaveBeenCalledTimes(4);
  });

  it('pins `retry: false`: a persistently-failing fetch stops after exactly one attempt, with no internal retries', async () => {
    const get = vi.mocked(api.getAitoTerminalPayment).mockRejectedValue(new Error('down'));

    renderHook(() => useTerminalPayment(12, 7, null), { wrapper });

    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    // The underlying query itself (not the observer's re-render-gated
    // result, which TerminalPaymentModal never reads for `error`) must
    // have already reached a terminal error state after one attempt —
    // React Query's default `retry: 3` would still be sleeping through a
    // backoff delay at this point instead.
    await waitFor(() => expect(client.getQueryState(QUERY_KEY)?.status).toBe('error'));
    expect(client.getQueryState(QUERY_KEY)?.fetchFailureCount).toBe(1);

    // With no successful fetch ever, `state.data` stays undefined, so
    // `refetchInterval` sees `isTerminalOpen(undefined) === false` and
    // never schedules a poll on its own — no retry backoff, no interval.
    await act(async () => { await vi.advanceTimersByTimeAsync(TERMINAL_POLL_MS * 5); });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('a transient failure after an open status leaves the stale data in place and keeps the poll alive', async () => {
    const get = vi.mocked(api.getAitoTerminalPayment)
      .mockResolvedValueOnce(tpe({ status: 'pending' }))
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValue(tpe({ status: 'processing' }));

    const { result } = renderHook(() => useTerminalPayment(12, 7, null), { wrapper });

    await waitFor(() => expect(result.current.data?.status).toBe('pending'));

    // The failing tick: the underlying query records the failure (this is
    // what `refetchInterval` reads via `query.state`), but `state.data` is
    // left untouched — still the last-known 'pending' row — because a
    // failed refetch never clears previously-fetched data.
    await act(async () => { await vi.advanceTimersByTimeAsync(TERMINAL_POLL_MS + 100); });
    expect(get).toHaveBeenCalledTimes(2);
    expect(client.getQueryState(QUERY_KEY)?.status).toBe('error');
    expect(client.getQueryState(QUERY_KEY)?.data?.status).toBe('pending');
    expect(result.current.data?.status).toBe('pending');

    // Because that stale data was still "open", `refetchInterval` kept
    // polling — the next tick fires right on schedule, not stalled or
    // frozen by the earlier error.
    await act(async () => { await vi.advanceTimersByTimeAsync(TERMINAL_POLL_MS + 100); });
    expect(get).toHaveBeenCalledTimes(3);
    expect(result.current.data?.status).toBe('processing');
  });
});
