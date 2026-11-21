import { describe, expect, it } from 'vitest';
import type { QuoteRow, QuoteState } from '../../../api/client';
import { chipOf, filterQuotes, quoteCounts, quotesPollMs } from '../../../components/orders/quotes';
import { SETTLED_POLL_MS } from '../../../components/orders/orderBoard';

const row = (o: Partial<QuoteRow> = {}): QuoteRow => ({
  id: 'e1', number: 'EST-001', customer: 'Acme', customer_id: 'c1', date: '2026-11-01', expiry_date: '2026-12-01',
  state: 'sent', total: 10, currency: 'CAD', reference: '', age_days: 1, is_core: true, editable: true,
  has_draft_order: false, modified: '', lines: [], ...o,
});
const all = { chip: 'current', text: '', coreOnly: false } as const;

describe('quotes helpers', () => {
  it('maps the five states to chips', () => {
    const chips = (['draft', 'sent', 'accepted', 'expired', 'declined'] as QuoteState[]).map(state => chipOf(row({ state })));
    expect(chips).toEqual(['current', 'current', 'current', 'expired', 'declined']);
  });

  it('counts per chip', () => {
    const rows = [row({ state: 'draft' }), row({ state: 'accepted' }), row({ state: 'expired' })];
    expect(quoteCounts(rows)).toEqual({ current: 2, expired: 1, declined: 0 });
  });

  it('finds a line SKU, ignoring accents and case', () => {
    const lines = [{ id: 'l', item_id: null, name: 'Vase', sku: 'VZ-42', quantity: 1, rate: 1, discount: null, total: 1, available: null }];
    const rows = [row({ id: 'a', lines }), row({ id: 'b', customer: 'Véronique' })];
    expect(filterQuotes(rows, { ...all, text: 'vz-42' }).map(r => r.id)).toEqual(['a']);
    expect(filterQuotes(rows, { ...all, text: 'véro' }).map(r => r.id)).toEqual(['b']);
    expect(filterQuotes(rows, { ...all, text: 'VERO' }).map(r => r.id)).toEqual(['b']);
  });

  it('still finds a row without lines by customer', () => {
    expect(filterQuotes([row({ lines: null })], { ...all, text: 'acme' })).toHaveLength(1);
  });

  it('coreOnly keeps is_core null but drops false', () => {
    const rows = [row({ id: 'n', is_core: null }), row({ id: 'f', is_core: false }), row({ id: 't', is_core: true })];
    expect(filterQuotes(rows, { ...all, coreOnly: true }).map(r => r.id).sort()).toEqual(['n', 't']);
  });

  it('sorts newest date first, then number descending', () => {
    const rows = [
      row({ id: 'a', date: '2026-11-01', number: 'EST-001' }),
      row({ id: 'b', date: '2026-11-05', number: 'EST-002' }),
      row({ id: 'c', date: '2026-11-05', number: 'EST-009' }),
    ];
    expect(filterQuotes(rows, all).map(r => r.id)).toEqual(['c', 'b', 'a']);
  });

  it('polls fast while quotes are still loading, then at the board\'s settled interval', () => {
    expect(quotesPollMs(undefined)).toBe(4000);
    expect(quotesPollMs({ rows: [], loading: 0, ready: false })).toBe(4000);
    expect(quotesPollMs({ rows: [], loading: 3, ready: true })).toBe(4000);
    expect(quotesPollMs({ rows: [], loading: 0, ready: true })).toBe(SETTLED_POLL_MS);
    expect(SETTLED_POLL_MS).toBe(180000);
  });
});
