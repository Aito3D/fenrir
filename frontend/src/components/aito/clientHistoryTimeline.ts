import type { AitoClientHistoryCard } from '../../api/client';
import { parseUTCDateStrict } from '../../utils/date';

/** What the history dialog asks `GET /aito/clients/{id}/history` for: the
 *  route's ceiling, which is more cards than any client of the shop has. The
 *  drawer's recall block asks for 5 under a different query key — the two
 *  never share a cache entry, on purpose (different limits, different data). */
export const CLIENT_TIMELINE_LIMIT = 200;

export interface TimelineSummary {
  /** Every row, declined ones included — they happened. */
  count: number;
  /** Lifetime revenue: declined quotes were never money, so they are left
   *  out of the sum while staying in the count. */
  total: number;
  /** The OLDEST card's `created_at`, raw; the dialog formats it. Null when
   *  there are no cards. The endpoint orders newest first, so it is the last
   *  row, but this does not rely on that. */
  since: string | null;
}

export function summariseTimeline(cards: AitoClientHistoryCard[]): TimelineSummary {
  let total = 0;
  let since: string | null = null;
  let sinceMs = Infinity;
  for (const card of cards) {
    if (card.quote_status !== 'declined') total += card.total;
    const ms = parseUTCDateStrict(card.created_at)?.getTime() ?? Infinity;
    if (ms < sinceMs) {
      sinceMs = ms;
      since = card.created_at;
    }
  }
  return { count: cards.length, total, since };
}

export type TimelineItem =
  | { kind: 'year'; year: number }
  | { kind: 'card'; card: AitoClientHistoryCard; year: number };

/** The endpoint's order (newest first), with a year marker slotted in before
 *  the first card of each year. Pure, so the dialog's render is a map. */
export function timelineItems(cards: AitoClientHistoryCard[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let currentYear: number | null = null;
  for (const card of cards) {
    const year = parseUTCDateStrict(card.created_at)?.getFullYear() ?? NaN;
    if (year !== currentYear) {
      items.push({ kind: 'year', year });
      currentYear = year;
    }
    items.push({ kind: 'card', card, year });
  }
  return items;
}
