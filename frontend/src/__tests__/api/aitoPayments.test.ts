import { describe, it, expect, vi, afterEach } from 'vitest';
import { api } from '../../api/client';

describe('aito counter payment api methods', () => {
  afterEach(() => vi.restoreAllMocks());

  it('call the five routes with the right method and body', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      seen.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    await api.startAitoTerminalPayment(12, { document_kind: 'invoice', document_id: 'inv-1', amount: 23000 });
    await api.getAitoTerminalPayment(12, 7);
    await api.recordAitoManualPayment(12, { document_kind: 'quote', document_id: 'e1', mode: 'cheque', amount: 100, reference: '42' });
    await api.createAitoInvoicePaymentLink(12, { document_id: 'inv-1', amount: 100 });
    await api.cancelAitoPaymentLink(12, 3);
    expect(seen.map((s) => [s.url.replace(/^.*\/api\/v1/, ''), s.init?.method ?? 'GET'])).toEqual([
      ['/aito/12/terminal-payment', 'POST'],
      ['/aito/12/terminal-payment/7', 'GET'],
      ['/aito/12/manual-payment', 'POST'],
      ['/aito/12/payment-link', 'POST'],
      ['/aito/12/payment-link/3/cancel', 'POST'],
    ]);
    expect(JSON.parse(String(seen[2].init?.body))).toEqual({ document_kind: 'quote', document_id: 'e1', mode: 'cheque', amount: 100, reference: '42' });
  });
});
