import { queryOptions } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { QuoteRow, QuotesResponse } from '../../api/client';
import { fold } from './itemSearchText';
import { SETTLED_POLL_MS } from './orderBoard';

/** Fast while the server is still reading quotes, then the board's slow fallback. */
export const quotesPollMs = (d: QuotesResponse | undefined): number => (!d?.ready || d.loading > 0 ? 4000 : SETTLED_POLL_MS);

/** The one quotes query: the page's Devis count and the Devis side share it. */
export const quotesQuery = queryOptions({
  queryKey: ['order-board', 'quotes'],
  queryFn: api.getQuotes,
  refetchInterval: q => quotesPollMs(q.state.data),
});

export type QuoteChip = 'current' | 'expired' | 'declined';

/** Draft, sent and accepted quotes are all "current". */
export const chipOf = (row: QuoteRow): QuoteChip =>
  row.state === 'expired' || row.state === 'declined' ? row.state : 'current';

export function quoteCounts(rows: QuoteRow[]): Record<QuoteChip, number> {
  const counts: Record<QuoteChip, number> = { current: 0, expired: 0, declined: 0 };
  for (const r of rows) counts[chipOf(r)]++;
  return counts;
}

export function filterQuotes(rows: QuoteRow[], f: { chip: QuoteChip; text: string; coreOnly: boolean }): QuoteRow[] {
  const q = fold(f.text.trim());
  return rows
    .filter(r => chipOf(r) === f.chip && (!f.coreOnly || r.is_core !== false))
    .filter(r => !q || [r.customer, r.number, r.reference, ...(r.lines ?? []).flatMap(l => [l.name, l.sku])].some(t => fold(t).includes(q)))
    .sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number));
}
