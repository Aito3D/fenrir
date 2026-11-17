/**
 * Toasts for Fenrir's own work in Zoho: right text and severity per kind,
 * silence for unvoiced kinds, and no double toast for the deposit modal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { AITO_ZOHO_EVENT, useAitoZohoToasts, type AitoZohoResult } from '../../hooks/useAitoPeerToasts';

const showToast = vi.fn();
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ showToast }) }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { username: 'paul' } }) }));

const send = (detail: AitoZohoResult) =>
  act(() => {
    window.dispatchEvent(new CustomEvent(AITO_ZOHO_EVENT, { detail }));
  });

/** Results coalesce for 1.5 s before they toast. */
const settle = () => act(() => void vi.advanceTimersByTime(1500));

describe('useAitoZohoToasts', () => {
  beforeEach(() => {
    showToast.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('names the document and the client on a created quote', () => {
    renderHook(() => useAitoZohoToasts());
    send({ kind: 'quote.created', doc: 'DEV26-3038', client: 'Client de passage', actor: null });
    settle();
    expect(showToast).toHaveBeenCalledWith('Quote DEV26-3038 created in Zoho · Client de passage', 'success');
  });

  it('tells a retainer apart from a payment on an invoice', () => {
    renderHook(() => useAitoZohoToasts());
    send({ kind: 'payment.manual.recorded', doc: 'RET-1', has_retainer: true });
    send({ kind: 'payment.manual.recorded', doc: 'FA-1', has_retainer: false });
    settle();
    expect(showToast.mock.calls.map((c) => c[0])).toEqual([
      'Deposit invoice RET-1 created in Zoho',
      'Payment on FA-1 recorded in Zoho',
    ]);
  });

  it('shows failures as errors with the reason', () => {
    renderHook(() => useAitoZohoToasts());
    send({ kind: 'sync.failed', doc: 'DEV26-1', error: 'boom' });
    settle();
    expect(showToast).toHaveBeenCalledWith('Zoho sync failed for DEV26-1: boom', 'error');
  });

  it('stays silent for unvoiced kinds and for my own applied deposit', () => {
    renderHook(() => useAitoZohoToasts());
    send({ kind: 'sync.pushed', doc: 'DEV26-1' });
    send({ kind: 'invoice.deposit_applied', doc: 'FA-1', actor: 'paul' });
    settle();
    expect(showToast).not.toHaveBeenCalled();
    send({ kind: 'invoice.deposit_applied', doc: 'FA-1', actor: 'marie' });
    settle();
    expect(showToast).toHaveBeenCalledWith('Deposit applied to invoice FA-1', 'success');
  });

  it("skips the actor's own send/create results (their mutation already toasts), colleagues still hear them", () => {
    renderHook(() => useAitoZohoToasts());
    const own = ['quote.emailed', 'invoice.emailed', 'retainer.emailed', 'invoice.created', 'payment_link.created'];
    for (const kind of own) send({ kind, doc: 'X-1', actor: 'paul' });
    settle();
    expect(showToast).not.toHaveBeenCalled();
    for (const kind of own) send({ kind, doc: 'X-1', actor: 'marie' });
    settle();
    // quote/invoice/retainer.emailed share one toast key: the first shows, the other two fold into a summary.
    expect(showToast.mock.calls.map((c) => c[0])).toEqual([
      'X-1 emailed to the client',
      'Invoice X-1 created in Zoho',
      'Payment link ready for X-1',
      '2 documents emailed to clients',
    ]);
  });

  it("still toasts the actor's own background kinds", () => {
    renderHook(() => useAitoZohoToasts());
    for (const kind of ['sync.failed', 'sync.conflict', 'payment_link.replaced', 'payment.manual.partial']) {
      send({ kind, doc: 'X-1', actor: 'paul' });
    }
    settle();
    expect(showToast).toHaveBeenCalledTimes(4);
  });

  it('shows a lone result at once, with no timer advance and no summary after', () => {
    renderHook(() => useAitoZohoToasts());
    send({ kind: 'quote.created', doc: 'Q-1', client: 'Acme' });
    expect(showToast).toHaveBeenCalledExactlyOnceWith('Quote Q-1 created in Zoho · Acme', 'success');
    settle();
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it('shows the first of a burst at once and folds the rest of the window into one summary per kind', () => {
    renderHook(() => useAitoZohoToasts());
    send({ kind: 'payment_link.replaced', doc: 'A-1', client: 'X' });
    send({ kind: 'sync.failed', doc: 'A-2', error: 'boom' });
    send({ kind: 'payment_link.created', doc: 'A-3' });
    send({ kind: 'payment_link.replaced', doc: 'A-4' });
    send({ kind: 'sync.failed', doc: 'A-5', error: 'bang' });
    expect(showToast.mock.calls).toEqual([
      ['Payment link ready for A-1 · X', 'success'],
      ['Zoho sync failed for A-2: boom', 'error'],
    ]);
    settle();
    expect(showToast.mock.calls.slice(2)).toEqual([
      ['2 payment links ready', 'success'],
      ['Zoho sync failed for 1 card', 'error'],
    ]);
  });

  it('starts a new window after the old one closes', () => {
    renderHook(() => useAitoZohoToasts());
    send({ kind: 'sync.failed', doc: 'A-1', error: 'boom' });
    settle();
    send({ kind: 'sync.failed', doc: 'A-2', error: 'bang' });
    settle();
    expect(showToast.mock.calls.map((c) => c[0])).toEqual([
      'Zoho sync failed for A-1: boom',
      'Zoho sync failed for A-2: bang',
    ]);
  });

  it('drops a pending summary on unmount', () => {
    const { unmount } = renderHook(() => useAitoZohoToasts());
    send({ kind: 'sync.failed', doc: 'A-1', error: 'boom' });
    send({ kind: 'sync.failed', doc: 'A-2', error: 'bang' });
    unmount();
    settle();
    expect(showToast).toHaveBeenCalledTimes(1);
  });
});
