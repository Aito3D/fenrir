import { describe, it, expect } from 'vitest';
import type { AitoPaymentLink, AitoTerminalPayment, AitoInvoice } from '../../api/client';
import { derivePaymentState, blockVisible, cellsEnabled, expiryText } from '../../components/aito/payment/paymentState';
import { quoteDocument, invoiceDocument } from '../../components/aito/payment/paymentDocument';
import { makeProject } from '../fixtures/aitoProject';
import { localDateKey } from '../../utils/date';
import i18n from '../../i18n';

const link = (o: Partial<AitoPaymentLink> = {}): AitoPaymentLink => ({
  id: 1, state: 'pending', amount: 25000, currency: 'XPF', url: 'https://pay/x', expires_on: '2026-10-05',
  paid_at: null, sync_error: null, minted: true, ...o,
});
const tpe = (o: Partial<AitoTerminalPayment> = {}): AitoTerminalPayment => ({
  id: 7, document_kind: 'invoice', document_number: 'FA-1', status: 'processing', amount: 23000, amount_confirmed: null,
  booking_status: 'pending', booking_error: null, sync_error: null, created_at: '2026-09-23T01:00:00', settled_at: null, ...o,
});

describe('derivePaymentState', () => {
  it('terminal processing beats everything', () => {
    expect(derivePaymentState(link(), tpe()).kind).toBe('terminal_processing');
  });
  it('needs_attention beats a pending link', () => {
    expect(derivePaymentState(link(), tpe({ status: 'needs_attention' })).kind).toBe('terminal_attention');
  });
  it('pending link beats an old paid terminal payment', () => {
    const s = derivePaymentState(link(), tpe({ status: 'paid', settled_at: '2026-09-01T00:00:00' }));
    expect(s.kind).toBe('link_pending');
  });
  it('paid takes the most recent channel and the confirmed amount', () => {
    const s = derivePaymentState(
      link({ state: 'paid', paid_at: '2026-09-20T00:00:00' }),
      tpe({ status: 'paid', amount_confirmed: 23001, settled_at: '2026-09-22T00:00:00', booking_status: 'failed' }),
    );
    expect(s).toEqual({ kind: 'paid', amount: 23001, channel: 'terminal', at: '2026-09-22T00:00:00', bookingFailed: true });
    const s2 = derivePaymentState(link({ state: 'paid', paid_at: '2026-09-23T00:00:00' }), tpe({ status: 'paid', settled_at: '2026-09-22T00:00:00' }));
    expect(s2).toMatchObject({ kind: 'paid', channel: 'link', amount: 25000, bookingFailed: false });
  });
  it('dead link, failed terminal, nothing', () => {
    expect(derivePaymentState(link({ state: 'expired' }), tpe({ status: 'failed' })).kind).toBe('link_dead');
    expect(derivePaymentState(null, tpe({ status: 'failed' })).kind).toBe('none');
    expect(derivePaymentState(undefined, undefined).kind).toBe('none');
  });
});

describe('blockVisible / cellsEnabled', () => {
  it('hides with nothing due and nothing to say', () => {
    expect(blockVisible(null, { kind: 'none' })).toBe(false);
    expect(blockVisible(null, { kind: 'link_dead', link: link({ state: 'expired' }) })).toBe(false);
    expect(blockVisible(null, { kind: 'paid', amount: 1, channel: 'link', at: null, bookingFailed: false })).toBe(true);
    expect(blockVisible(100, { kind: 'none' })).toBe(true);
  });
  it('cells need canUpdate, something due, and no charge in flight', () => {
    expect(cellsEnabled({ canUpdate: true, due: 100, state: { kind: 'none' } })).toBe(true);
    expect(cellsEnabled({ canUpdate: false, due: 100, state: { kind: 'none' } })).toBe(false);
    expect(cellsEnabled({ canUpdate: true, due: null, state: { kind: 'none' } })).toBe(false);
    expect(cellsEnabled({ canUpdate: true, due: 100, state: { kind: 'terminal_processing', payment: tpe() } })).toBe(false);
  });
});

describe('documents', () => {
  it('quote uses the deposit rule and null without a quote', () => {
    const p = makeProject({ quote_id: 'e1', quote_number: 'DEV-1', quote_total: 100000, retainer_paid_total: 10000 });
    expect(quoteDocument(p, 30, 'XPF')).toEqual({ kind: 'quote', id: 'e1', number: 'DEV-1', due: 20000, currency: 'XPF' });
    expect(quoteDocument(makeProject({ quote_id: null, quote_number: null }), 30, 'XPF')).toBeNull();
    expect(quoteDocument(makeProject({ quote_id: 'e1', quote_number: 'DEV-1', quote_total: 100, retainer_paid_total: 100 }), 0, 'XPF')?.due).toBeNull();
  });
  it('invoice due is its balance, rounded up', () => {
    const inv: AitoInvoice = { id: 'i1', number: 'FA-1', date: '', due_date: '', total: 48000, balance: 22999.5, currency_code: 'XPF', status: 'sent', url: '', invoice_count: 1 };
    expect(invoiceDocument(inv)).toEqual({ kind: 'invoice', id: 'i1', number: 'FA-1', due: 23000, currency: 'XPF' });
    expect(invoiceDocument({ ...inv, balance: 0 }).due).toBeNull();
  });
});

describe('expiryText', () => {
  const t = i18n.getFixedT('en');
  const today = new Date();

  it('reads "Expires in 13 days" 13 days out', () => {
    const future = new Date(today);
    future.setDate(future.getDate() + 13);
    expect(expiryText(t, localDateKey(future), 'en').text).toBe('Expires in 13 days');
  });

  it('reads "Expires today" for today', () => {
    expect(expiryText(t, localDateKey(today), 'en').text).toBe('Expires today');
  });

  it('reads "Expired" for yesterday', () => {
    const past = new Date(today);
    past.setDate(past.getDate() - 1);
    expect(expiryText(t, localDateKey(past), 'en').text).toBe('Expired');
  });
});
