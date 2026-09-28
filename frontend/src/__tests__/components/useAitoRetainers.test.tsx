import type { ReactNode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, type AitoRetainerInvoice } from '../../api/client';
import { mayHaveRetainers, useAitoRetainers } from '../../components/aito/useAitoRetainers';
import { makeProject } from '../fixtures/aitoProject';

const ROW: AitoRetainerInvoice = {
  id: 'RET-B', number: 'AC-26-0031', date: '2026-09-03', total: 17500, balance: 0, currency_code: 'XPF', status: 'paid',
  url: 'https://books.zoho.eu/app/org1#/retainerinvoices/RET-B',
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('mayHaveRetainers', () => {
  it('is false for a quoted job with nothing paid, so the panel costs no Books calls', () => {
    expect(mayHaveRetainers(makeProject({ quote_id: 'E1', retainer_paid_total: null, customer_credit_total: null }))).toBe(false);
    expect(mayHaveRetainers(makeProject({ quote_id: 'E1', retainer_paid_total: 0, customer_credit_total: 0 }))).toBe(false);
  });

  it('is false without a quote whatever else is set', () => {
    expect(mayHaveRetainers(makeProject({ quote_id: null, retainer_paid_total: 5000, quote_invoiced: true }))).toBe(false);
  });

  it('is true on a paid deposit, customer credit, an invoiced quote or an unmanaged card', () => {
    expect(mayHaveRetainers(makeProject({ quote_id: 'E1', retainer_paid_total: 5000 }))).toBe(true);
    expect(mayHaveRetainers(makeProject({ quote_id: 'E1', customer_credit_total: 10 }))).toBe(true);
    expect(mayHaveRetainers(makeProject({ quote_id: 'E1', quote_invoiced: true }))).toBe(true);
    expect(mayHaveRetainers(makeProject({ quote_id: 'E1', quote_sync_state: 'unmanaged' }))).toBe(true);
  });
});

describe('useAitoRetainers', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fetches the rows when the project may have retainers', async () => {
    vi.spyOn(api, 'getAitoRetainers').mockResolvedValue([ROW]);
    const { result } = renderHook(() => useAitoRetainers(makeProject({ id: 12, quote_id: 'E1', retainer_paid_total: 17500 })), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([ROW]));
    expect(api.getAitoRetainers).toHaveBeenCalledWith(12);
  });

  it('never asks Books for a quoted, unpaid job', async () => {
    const spy = vi.spyOn(api, 'getAitoRetainers');
    const { result } = renderHook(() => useAitoRetainers(makeProject({ id: 12, quote_id: 'E1' })), { wrapper });
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(spy).not.toHaveBeenCalled();
  });
});
