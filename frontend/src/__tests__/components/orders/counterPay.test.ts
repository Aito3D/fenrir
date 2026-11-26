import { describe, expect, it } from 'vitest';
import type { OrderBoardLine, OrderBoardRow, OrderInvoice } from '../../../api/client';
import { attributed, invoiceOf, pickLines, rowOf, shortLines } from '../../../components/orders/counterPay';

const line = (o: Partial<OrderBoardLine> = {}): OrderBoardLine => ({
  id: 'l1', item_id: 'A', name: 'Thing', sku: 'SKU-1', state: 'ready', quantity: 1, shipped: 0, cancelled: 0,
  remaining: 1, invoiced: 0, packed_waiting: 0, stock_available: 1, covered: 1, packable: 1, shortfall: 0, rate: 3400, floor: 0, covered_by_po: 0,
  po_numbers: [], ...o,
});

const row = (lines: OrderBoardLine[], o: Partial<OrderBoardRow> = {}): OrderBoardRow => ({
  id: 'so1', number: 'SO-00001', customer: 'Atelier Moana', date: '2026-10-02', total: 100, currency: 'XPF',
  status: 'to_ship', age_days: 5, is_core: true, ready_ratio: 1, packed: 0, unbilled_units: 0, prep: null,
  units: { total: 1, shipped: 0, ready: 1, backordered: 0, to_order: 0 }, packages: [], lines,
  zoho_url: null, customer_id: '', payment: null, contact: null,
  facts: { channel: '', reference: '', shopify_order: '', quote_number: '', delivery_method: '', payment_terms: '', shopify_url: null, quote_url: null }, version: 'v1', estimable: true, ...o,
});

const inv: OrderInvoice = { id: 'i1', number: 'INV-1', date: '', due_date: '', total: 0, balance: 0, status: 'sent', url: null };
const mixed = row([
  line({ id: 'ok', remaining: 2 }),
  line({ id: 'short', remaining: 3, packed_waiting: 2, stock_available: 0, shortfall: 1 }),
  line({ id: 'svc', stock_available: null, shortfall: 1 }),
]);

describe('counterPay', () => {
  it('asks only about goods lines with a shortfall', () => {
    expect(shortLines(mixed).map((l) => l.id)).toEqual(['short']);
  });
  it('adds a "yes" line whole and lists it in force', () => {
    const r = pickLines(mixed, [{ line_id: 'ok', quantity: 2 }], new Set(['short']));
    expect(r.lines).toEqual([{ line_id: 'ok', quantity: 2 }, { line_id: 'short', quantity: 1 }]);
    expect(r.force).toEqual(['short']);
  });
  it('replaces a line Books already offered instead of duplicating it', () => {
    const r = pickLines(mixed, [{ line_id: 'short', quantity: 0.5 }], new Set(['short']));
    expect(r.lines).toEqual([{ line_id: 'short', quantity: 1 }]);
  });
  it('leaves a "no" line out and returns no lines for a service-only order', () => {
    expect(pickLines(mixed, [{ line_id: 'ok', quantity: 2 }], new Set())).toEqual({ lines: [{ line_id: 'ok', quantity: 2 }], force: [] });
    expect(pickLines(row([line({ id: 'svc', stock_available: null })]), [], new Set()).lines).toEqual([]);
  });
  it('a full payment is attributed at balance 0', () => {
    expect(attributed({ ...inv, total: 12400, balance: 0 }, 12400)).toBe(true);
    expect(attributed({ ...inv, total: 12400, balance: 12400 }, 12400)).toBe(false);
  });
  it('a partial payment is attributed when the balance is the rest', () => {
    expect(attributed({ ...inv, total: 12400, balance: 2400 }, 10000)).toBe(true);
  });
  it('pay later is attributed with a full balance, and a missing invoice never is', () => {
    expect(attributed({ ...inv, total: 12400, balance: 12400 }, 0)).toBe(true);
    expect(attributed(undefined, 0)).toBe(false);
  });
  it('finds an invoice by number and a row by id', () => {
    const r = row([], { payment: { invoices: [inv] } as unknown as OrderBoardRow['payment'] });
    expect(invoiceOf(r, 'INV-1')).toBe(inv);
    expect(invoiceOf(r, null)).toBeUndefined();
    expect(invoiceOf(undefined, 'INV-1')).toBeUndefined();
    expect(rowOf({ rows: [r] } as never, 'so1')).toBe(r);
    expect(rowOf({ rows: [r] } as never, 'nope')).toBeUndefined();
  });
});
