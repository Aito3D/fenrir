import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { ApiError } from '../../../api/client';
import { errorReason } from '../../../components/orders/orderErrors';

const t = ((key: string) => key) as unknown as TFunction;

describe('errorReason', () => {
  it.each(['nothing_to_pack', 'unknown_package', 'unknown_picklist', 'order_invoiced', 'ref_reused'])('gives %s its own message, not the generic stale one', (code) => {
    expect(errorReason(t, new ApiError(code, 400))).toBe(`orders.err.${code}`);
  });

  it('keeps the generic stale message for an unlisted refusal code', () => {
    expect(errorReason(t, new ApiError('something_else', 400))).toBe('orders.parcel.stale');
  });
});
