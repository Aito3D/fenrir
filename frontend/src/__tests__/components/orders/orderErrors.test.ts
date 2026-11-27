import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { ApiError } from '../../../api/client';
import type { OrderHandoverOutcome } from '../../../api/client';
import { errorReason, failedStepText } from '../../../components/orders/orderErrors';

const t = ((key: string, o?: { reason?: string }) => (o && 'reason' in o ? `${key}|${o.reason}` : key)) as unknown as TFunction;

describe('errorReason', () => {
  it.each(['nothing_to_pack', 'unknown_package', 'unknown_picklist', 'order_invoiced', 'ref_reused'])('gives %s its own message, not the generic stale one', (code) => {
    expect(errorReason(t, new ApiError(code, 400))).toBe(`orders.err.${code}`);
  });

  it('keeps the generic stale message for an unlisted refusal code', () => {
    expect(errorReason(t, new ApiError('something_else', 400))).toBe('orders.parcel.stale');
  });

  it('a 503 is the busy message', () => {
    expect(errorReason(t, new ApiError('x', 503))).toBe('orders.busy');
  });

  it.each([404, 409])('a %i is the stale message', (status) => {
    expect(errorReason(t, new ApiError('x', status))).toBe('orders.parcel.stale');
  });

  it('a 400 with a listed code under a scope falls back through the scope key', () => {
    expect(errorReason(t, new ApiError('bad_discount', 400), 'orders.quote.err')).toBe('orders.quote.err.bad_discount');
  });

  it('a plain Error is its message, a non-Error is empty, and an unrefused ApiError is its message', () => {
    expect(errorReason(t, new Error('boom'))).toBe('boom');
    expect(errorReason(t, 'str')).toBe('');
    expect(errorReason(t, new ApiError('teapot', 500))).toBe('teapot');
  });
});

describe('failedStepText', () => {
  const o = (failed_step: string | null, error: string | null) => ({ failed_step, error }) as unknown as OrderHandoverOutcome;
  it.each([
    ['credit', 'credit_off_board', 'orders.handover.creditOffBoard'],
    ['invoice', 'prefill_refused', 'orders.handover.prefillRefused'],
    ['invoice', 'zoho 500', 'orders.handover.invoiceFailed|zoho 500'],
    ['sent', 'mail down', 'orders.handover.invoiceFailed|mail down'],
    ['invoice', null, 'orders.handover.invoiceFailed|'],
    ['delivered', 'x', 'orders.handover.failed|x'],
    ['credit', 'other', 'orders.handover.failed|other'],
    ['credit', null, 'orders.handover.failed|'],
    [null, 'x', 'orders.handover.failed|x'],
  ])('%s / %s -> %s', (step, error, expected) => {
    expect(failedStepText(t, o(step, error))).toBe(expected);
  });
});
