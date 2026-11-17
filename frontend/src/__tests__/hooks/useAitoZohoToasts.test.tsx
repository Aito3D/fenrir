/**
 * Toasts for Fenrir's own work in Zoho: right text and severity per kind,
 * silence for unvoiced kinds, and no double toast for the deposit modal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { AITO_ZOHO_EVENT, useAitoZohoToasts, type AitoZohoResult } from '../../hooks/useAitoPeerToasts';

const showToast = vi.fn();
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ showToast }) }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { username: 'paul' } }) }));

const send = (detail: AitoZohoResult) =>
  act(() => {
    window.dispatchEvent(new CustomEvent(AITO_ZOHO_EVENT, { detail }));
  });

describe('useAitoZohoToasts', () => {
  beforeEach(() => showToast.mockClear());

  it('names the document and the client on a created quote', () => {
    renderHook(() => useAitoZohoToasts());
    send({ kind: 'quote.created', doc: 'DEV26-3038', client: 'Client de passage', actor: null });
    expect(showToast).toHaveBeenCalledWith('Quote DEV26-3038 created in Zoho · Client de passage', 'success');
  });

  it('tells a retainer apart from a payment on an invoice', () => {
    renderHook(() => useAitoZohoToasts());
    send({ kind: 'payment.manual.recorded', doc: 'RET-1', has_retainer: true });
    send({ kind: 'payment.manual.recorded', doc: 'FA-1', has_retainer: false });
    expect(showToast.mock.calls.map((c) => c[0])).toEqual([
      'Deposit invoice RET-1 created in Zoho',
      'Payment on FA-1 recorded in Zoho',
    ]);
  });

  it('shows failures as errors with the reason', () => {
    renderHook(() => useAitoZohoToasts());
    send({ kind: 'sync.failed', doc: 'DEV26-1', error: 'boom' });
    expect(showToast).toHaveBeenCalledWith('Zoho sync failed for DEV26-1: boom', 'error');
  });

  it('stays silent for unvoiced kinds and for my own applied deposit', () => {
    renderHook(() => useAitoZohoToasts());
    send({ kind: 'sync.pushed', doc: 'DEV26-1' });
    send({ kind: 'invoice.deposit_applied', doc: 'FA-1', actor: 'paul' });
    expect(showToast).not.toHaveBeenCalled();
    send({ kind: 'invoice.deposit_applied', doc: 'FA-1', actor: 'marie' });
    expect(showToast).toHaveBeenCalledWith('Deposit applied to invoice FA-1', 'success');
  });

  it("skips the actor's own send/create results (their mutation already toasts), colleagues still hear them", () => {
    renderHook(() => useAitoZohoToasts());
    const own = ['quote.emailed', 'invoice.emailed', 'retainer.emailed', 'invoice.created', 'payment_link.created'];
    for (const kind of own) send({ kind, doc: 'X-1', actor: 'paul' });
    expect(showToast).not.toHaveBeenCalled();
    for (const kind of own) send({ kind, doc: 'X-1', actor: 'marie' });
    expect(showToast).toHaveBeenCalledTimes(own.length);
  });

  it("still toasts the actor's own background kinds", () => {
    renderHook(() => useAitoZohoToasts());
    for (const kind of ['sync.failed', 'sync.conflict', 'payment_link.replaced', 'payment.manual.partial']) {
      send({ kind, doc: 'X-1', actor: 'paul' });
    }
    expect(showToast).toHaveBeenCalledTimes(4);
  });
});
