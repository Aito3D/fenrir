import { describe, it, expect } from 'vitest';
import { invoiceStatusLabelKey, invoiceStatusTone } from '../../components/aito/invoiceStatus';

// invoiceStatusLabelKey and invoiceStatusTone both guard their map lookup with
// `Object.hasOwn` rather than a bare `MAP[status]`, for the same reason
// quoteStatus.ts's twin functions do (see quoteStatus.test.ts): `status`
// arrives as free text from Zoho with no runtime validation against the
// closed union the TypeScript type promises. A bare lookup for a status that
// happens to name an inherited `Object.prototype` member — 'toString',
// 'constructor', 'valueOf' — would resolve that member instead of
// `undefined`, which is a different bug from (and easy to conflate with) the
// ordinary "unmapped status" case this module's other tests already cover
// via values like 'disputed'. Direct unit tests here pin the exact contract
// of both functions and cannot be broken by unrelated churn in InvoiceCard; a
// parallel case in AitoInvoiceCard.test.tsx additionally proves the guard
// holds end-to-end through the component that actually renders these
// statuses.
describe('invoiceStatusLabelKey', () => {
  it('returns the mapped i18n key for a real status', () => {
    expect(invoiceStatusLabelKey('paid')).toBe('aito.invoiceStatus.paid');
  });

  it('returns null for an ordinary unmapped status', () => {
    expect(invoiceStatusLabelKey('disputed')).toBeNull();
  });

  it.each(['toString', 'constructor', 'valueOf'])(
    'returns null, not the inherited Object.prototype member, for %s',
    (status) => {
      expect(invoiceStatusLabelKey(status)).toBeNull();
    },
  );
});

describe('invoiceStatusTone', () => {
  it('returns the mapped tone for a real status', () => {
    expect(invoiceStatusTone('paid')).toBe('success');
  });

  it('returns neutral for an ordinary unmapped status', () => {
    expect(invoiceStatusTone('disputed')).toBe('neutral');
  });

  it.each(['toString', 'constructor', 'valueOf'])(
    'returns neutral, not the inherited Object.prototype member, for %s',
    (status) => {
      expect(invoiceStatusTone(status)).toBe('neutral');
    },
  );
});
