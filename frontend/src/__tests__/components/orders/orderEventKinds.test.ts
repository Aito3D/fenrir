import { describe, expect, it } from 'vitest';
import { orderEventLabel } from '../../../components/orders/orderEventKinds';

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
