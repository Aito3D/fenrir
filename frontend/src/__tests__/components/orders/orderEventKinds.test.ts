import { describe, expect, it } from 'vitest';
import { orderEventDetail, orderEventLabel } from '../../../components/orders/orderEventKinds';

describe('orderEventLabel order.cancel_failed', () => {
  it('names the deleted parcels and picklists', () => {
    expect(orderEventLabel({ kind: 'order.cancel_failed', detail: { packages: ['PKG-1', 'PKG-2'], picklists: ['PL-1'] } }, 'XPF')).toEqual({
      key: 'orders.history.orderCancelFailed',
      params: { packages: 'PKG-1, PKG-2', picklists: 'PL-1' },
    });
  });

  it('shows a dash for an empty list', () => {
    expect(orderEventLabel({ kind: 'order.cancel_failed', detail: { packages: [], picklists: ['PL-1'] } }, 'XPF')?.params).toEqual({
      packages: '—',
      picklists: 'PL-1',
    });
  });
});

describe('orderEventLabel order.void_failed', () => {
  it('names the draft left in Books', () => {
    expect(orderEventLabel({ kind: 'order.void_failed', detail: { order: 'SO-00009' } }, 'XPF')).toEqual({
      key: 'orders.history.orderVoidFailed',
      params: { order: 'SO-00009' },
    });
  });
});

// The translator echoes key and params so each assertion pins the exact line the row shows.
const t = (key: string, options?: Record<string, unknown>) => (options ? `${key}${JSON.stringify(options)}` : key);
const detail = (kind: string, d?: Record<string, unknown>) => orderEventDetail({ kind, detail: d } as never, 'USD', t);
const money = (n: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(n);

describe('orderEventDetail', () => {
  it.each(['sms.sent', 'invoice.emailed', 'document.emailed'])('%s shows the recipient address', (kind) => {
    expect(detail(kind, { to: 'a@b.co' })).toBe('a@b.co');
    expect(detail(kind, {})).toBeNull();
    expect(detail(kind, { to: '' })).toBeNull();
    expect(detail(kind)).toBeNull();
  });

  it('prep.printed shows the picklist', () => {
    expect(detail('prep.printed', { picklist: 'PL-7' })).toBe('PL-7');
    expect(detail('prep.printed', {})).toBeNull();
  });

  it.each(['terminal.started', 'payment_link.sent', 'payment_link.cancelled'])('%s joins amount and document', (kind) => {
    expect(detail(kind, { amount: 12, document: 'INV-1' })).toBe(`${money(12)} · INV-1`);
    expect(detail(kind, { amount: 12 })).toBe(money(12));
    expect(detail(kind, { document: 'INV-1' })).toBe('INV-1');
    expect(detail(kind, {})).toBeNull();
    expect(detail(kind)).toBeNull();
  });

  it('order.received joins units, total and pickup', () => {
    expect(detail('order.received', { units: 8, total: 192, pickup: true })).toBe(
      `orders.units{"count":8} · ${money(192)} · orders.history.sub.pickup`,
    );
    expect(detail('order.received', {})).toBeNull();
  });

  it('picklist.created shows the unit count', () => {
    expect(detail('picklist.created', { units: 3 })).toBe('orders.units{"count":3}');
    expect(detail('picklist.created', {})).toBeNull();
  });

  it('package.created joins units and source picklist', () => {
    expect(detail('package.created', { units: 2, picklist: 'PL-1' })).toBe(
      'orders.units{"count":2} · orders.history.sub.fromPicklist{"picklist":"PL-1"}',
    );
    expect(detail('package.created', {})).toBeNull();
  });

  it('invoice.created shows total and applied credit', () => {
    expect(detail('invoice.created', { total: 50, credit_applied: 5 })).toBe(
      `${money(50)} · orders.history.sub.credit{"amount":"${money(5)}"}`,
    );
    expect(detail('invoice.created', { total: 50, credit_applied: 0 })).toBe(money(50));
    expect(detail('invoice.created', {})).toBeNull();
  });

  it('payment.received needs both paid and total', () => {
    expect(detail('payment.received', { paid: 10, total: 20 })).toBe(
      `orders.history.sub.paidOf{"paid":"${money(10)}","total":"${money(20)}"}`,
    );
    expect(detail('payment.received', { paid: 10 })).toBeNull();
  });

  it('order.edited needs both totals', () => {
    expect(detail('order.edited', { total_from: 10, total_to: 20 })).toBe(
      `orders.history.sub.total{"from":"${money(10)}","to":"${money(20)}"}`,
    );
    expect(detail('order.edited', { total_from: 10 })).toBeNull();
  });

  it('returns null for a kind without a detail line', () => {
    expect(detail('note.added', { to: 'x' })).toBeNull();
  });
});

describe('orderEventLabel remaining kinds', () => {
  const label = (kind: string, d?: Record<string, unknown>) => orderEventLabel({ kind, detail: d } as never, 'USD');
  const amount = money(5);

  it.each([
    ['order.received', { source: 'shopify', reference: '#1' }, 'orders.history.orderReceivedShopify', { reference: '#1' }],
    ['order.received', { source: 'quote' }, 'orders.history.orderReceivedQuote', { reference: '—' }],
    ['package.edited', { deleted: true, package: 'P1' }, 'orders.history.packageDeleted', { package: 'P1' }],
    ['package.edited', { package: 'P1' }, 'orders.history.packageEdited', { package: 'P1' }],
    ['package.created', { package: 'P2' }, 'orders.history.packageCreated', { package: 'P2' }],
    ['handover.delivered', {}, 'orders.history.handoverDelivered', { package: '—' }],
    ['handover.shipped', { package: 'P3' }, 'orders.history.handoverShipped', { package: 'P3' }],
    ['picklist.created', { picklist: 'PL-1' }, 'orders.history.picklistCreated', { picklist: 'PL-1' }],
    ['invoice.created', { invoice: 'INV-1' }, 'orders.history.invoiceCreated', { invoice: 'INV-1' }],
    ['invoice.emailed', {}, 'orders.history.invoiceEmailed', { invoice: '—' }],
    ['document.emailed', { document: 'D1' }, 'orders.history.documentEmailed', { document: 'D1' }],
    ['credit.applied', { invoice: 'INV-2', amount: 5 }, 'orders.history.creditApplied', { invoice: 'INV-2', amount }],
    ['credit.applied', {}, 'orders.history.creditApplied', { invoice: '—', amount: '—' }],
    ['payment.received', { amount: 5 }, 'orders.history.paymentReceived', { amount }],
    ['payment.received', {}, 'orders.history.paymentReceived', { amount: '—' }],
  ])('%s %j', (kind, d, key, params) => {
    expect(label(kind, d)).toEqual({ key, params });
  });

  it('order.received without a source has no params', () => {
    expect(label('order.received')).toEqual({ key: 'orders.history.orderReceived' });
  });

  it('plain kinds map to their key; unknown kinds to null', () => {
    expect(label('note.added')).toEqual({ key: 'orders.history.noteAdded' });
    expect(label('nope.unknown')).toBeNull();
  });
});
