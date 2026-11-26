/** A client's history: open and shipped orders of that customer only, newest first. */
import { describe, it, expect } from 'vitest';
import type { FinishedOrderRow, OrderBoardRow } from '../../../api/client';
import { clientOrders } from '../../../components/orders/orderBoard';

const open = (o: Partial<OrderBoardRow>) => ({ id: 'o', number: 'SO-1', customer_id: 'c1', date: '2026-11-01', total: 100, currency: 'XPF', status: 'to_ship', payment: null, lines: [], ...o }) as OrderBoardRow;
const done = (o: Partial<FinishedOrderRow>) => ({ id: 'f', number: 'SO-0', customer_id: 'c1', date: '2025-03-01', total: 50, currency: 'XPF', paid_flag: 'paid', payment: null, ...o }) as FinishedOrderRow;

describe('clientOrders', () => {
  it('merges both lists for the customer, newest first, and carries what is left to pay', () => {
    const rows = clientOrders(
      'c1',
      [open({ id: 'a', payment: { state: 'unpaid', left: 100 } as OrderBoardRow['payment'] }), open({ id: 'x', customer_id: 'c2' })],
      [done({ id: 'b' }), done({ id: 'c', date: '2026-12-01' }), done({ id: 'y', customer_id: 'c2' })],
    );
    expect(rows.map(r => r.id)).toEqual(['c', 'a', 'b']);
    expect(rows[1]).toMatchObject({ status: 'to_ship', state: 'unpaid', left: 100, lines: [] });
    expect(rows[2]).toMatchObject({ status: null, state: 'paid', left: 0, lines: null });
  });

  it('is empty without a customer', () => {
    expect(clientOrders('', [open({ customer_id: '' })], [])).toEqual([]);
  });
});
