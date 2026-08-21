import { describe, it, expect } from 'vitest';
import { quoteStatusLabelKey, quoteStatusTone } from '../../components/aito/quoteStatus';

// quoteStatusLabelKey and quoteStatusTone both guard their map lookup with
// `Object.hasOwn` rather than a bare `MAP[status]`, because `status` is free
// text accepted from the client (see POST /aito/, max 30 chars) with no
// runtime validation against the closed union the TypeScript type promises.
// A bare lookup for a status that happens to name an inherited
// `Object.prototype` member — 'toString', 'constructor', 'valueOf' — would
// resolve that member instead of `undefined`, which is a different bug from
// (and easy to conflate with) the ordinary "unmapped status" case that the
// rest of this module's tests already cover via values like 'on_hold'.
// Direct unit tests here pin the exact contract of both functions and cannot
// be broken by unrelated churn in ProjectDetailPanel; a parallel case in
// ProjectDetailPanel.test.tsx additionally proves the guard holds end-to-end
// through the component that actually renders these statuses.
describe('quoteStatusLabelKey', () => {
  it('returns the mapped i18n key for a real status', () => {
    expect(quoteStatusLabelKey('accepted')).toBe('aito.quoteStatus.accepted');
  });

  it('returns null for an ordinary unmapped status', () => {
    expect(quoteStatusLabelKey('on_hold')).toBeNull();
  });

  it.each(['toString', 'constructor', 'valueOf'])(
    'returns null, not the inherited Object.prototype member, for %s',
    (status) => {
      expect(quoteStatusLabelKey(status)).toBeNull();
    },
  );
});

describe('quoteStatusTone', () => {
  it('returns the mapped tone for a real status', () => {
    expect(quoteStatusTone('accepted')).toBe('success');
  });

  it('returns neutral for an ordinary unmapped status', () => {
    expect(quoteStatusTone('on_hold')).toBe('neutral');
  });

  it.each(['toString', 'constructor', 'valueOf'])(
    'returns neutral, not the inherited Object.prototype member, for %s',
    (status) => {
      expect(quoteStatusTone(status)).toBe('neutral');
    },
  );
});
