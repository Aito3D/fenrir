/**
 * useSendInvoiceMutation writes Books' own post-send invoice straight into
 * the ['aito-invoice', projectId] cache entry — see the hook's own docstring
 * for why (Books flips the invoice to `status: 'sent'` as a side effect of
 * the send itself, and a mere invalidate-and-refetch would show "Draft" for
 * one more render). That cache key is the entire reason the endpoint returns
 * an invoice at all rather than 204, and it is the one place the key could
 * silently drift from InvoiceCard.tsx's own `['aito-invoice', project.id]`
 * read without a single test noticing — every SendInvoiceModal test stops at
 * "sendAitoInvoiceEmail was called", never at what the cache holds
 * afterwards. This file closes that gap directly, at the hook level, the
 * same way useQuoteStatusMutation.test.tsx pins its own mutation's cache
 * writes without going through a full modal render.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSendInvoiceMutation } from '../../hooks/useSendInvoiceMutation';
import { api, type AitoInvoice } from '../../api/client';

// Mocked BEFORE any importing module runs, same pattern useWebSocket.test.ts
// and useQuoteStatusMutation.test.tsx use: `t` returns the key so assertions
// need not depend on a translated string.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Mocked directly rather than wrapped in the real ToastProvider: the hook
// only needs `showToast`, and mocking it lets the tests assert on exactly
// what was shown without rendering the toast portal.
const showToastMock = vi.fn();
vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: showToastMock }),
}));

const SENT_INVOICE = {
  id: 'INV-7',
  number: 'INV-00087',
  date: '2026-08-18',
  due_date: '2026-09-18',
  total: 45000,
  balance: 0,
  currency_code: 'XPF',
  status: 'sent',
  url: 'https://books.zoho.com/app#/invoices/INV-7',
  invoice_count: 1,
} as AitoInvoice;

function renderSendInvoiceHook(projectId: number, invoiceId: string, onDone = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useSendInvoiceMutation(projectId, invoiceId, onDone), { wrapper });
  return { ...hook, client };
}

describe('useSendInvoiceMutation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    showToastMock.mockClear();
  });

  it("writes Books' post-send invoice into the exact cache key InvoiceCard reads", async () => {
    vi.spyOn(api, 'sendAitoInvoiceEmail').mockResolvedValue(SENT_INVOICE);
    const { result, client } = renderSendInvoiceHook(12, 'INV-7');

    act(() => {
      result.current.mutate('contact@example.pf');
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // The exact key, not a shape match: InvoiceCard.tsx's own useQuery reads
    // ['aito-invoice', project.id] — a mutation that wrote to a differently
    // shaped or misspelled key would pass every existing modal test (which
    // only checks the API call) while leaving the card showing stale data
    // forever, since nothing would ever invalidate the key it actually reads.
    expect(client.getQueryData(['aito-invoice', 12])).toEqual(SENT_INVOICE);
  });

  it('does not touch a different project or invoice id', async () => {
    vi.spyOn(api, 'sendAitoInvoiceEmail').mockResolvedValue(SENT_INVOICE);
    const { result, client } = renderSendInvoiceHook(12, 'INV-7');
    client.setQueryData(['aito-invoice', 99], { id: 'unrelated' });

    act(() => {
      result.current.mutate('contact@example.pf');
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(client.getQueryData(['aito-invoice', 99])).toEqual({ id: 'unrelated' });
  });
});
