import { describe, it, expect } from 'vitest';
import type { AitoClientHistoryCard } from '../../api/client';
import { summariseTimeline, timelineItems, CLIENT_TIMELINE_LIMIT } from '../../components/aito/clientHistoryTimeline';

// Hours ≥ 10:00 UTC: the sandbox is UTC-10 and an earlier hour renders as
// the previous local day (AitoDoneGrid precedent).
const card = (over: Partial<AitoClientHistoryCard>): AitoClientHistoryCard => ({
  id: 1,
  created_at: '2026-09-07T10:00:00',
  column: 'print',
  total: 3750,
  quote_number: 'DEV26-2656',
  quote_status: 'sent',
  description: 'Pièce carrosserie',
  tasks: [],
  ...over,
});

describe('summariseTimeline', () => {
  it('counts every card but sums only the non-declined totals, and dates from the oldest card', () => {
    const cards = [
      card({ id: 41, total: 3750 }),
      card({ id: 17, total: 6200, quote_status: 'declined', created_at: '2026-04-03T10:00:00' }),
      card({ id: 4, total: 2000, quote_number: null, quote_status: null, created_at: '2025-09-02T10:00:00' }),
    ];
    expect(summariseTimeline(cards)).toEqual({ count: 3, total: 5750, since: '2025-09-02T10:00:00' });
  });

  it('is empty-safe', () => {
    expect(summariseTimeline([])).toEqual({ count: 0, total: 0, since: null });
  });
});

describe('timelineItems', () => {
  it('inserts a year marker before the first card of each year, keeping the order', () => {
    const a = card({ id: 41, created_at: '2026-09-07T10:00:00' });
    const b = card({ id: 33, created_at: '2026-07-30T10:00:00' });
    const c = card({ id: 9, created_at: '2025-11-18T10:00:00' });
    expect(timelineItems([a, b, c])).toEqual([
      { kind: 'year', year: 2026 },
      { kind: 'card', card: a, year: 2026 },
      { kind: 'card', card: b, year: 2026 },
      { kind: 'year', year: 2025 },
      { kind: 'card', card: c, year: 2025 },
    ]);
  });

  it('returns nothing for no cards', () => {
    expect(timelineItems([])).toEqual([]);
  });
});

it('asks the endpoint for its ceiling', () => {
  expect(CLIENT_TIMELINE_LIMIT).toBe(200);
});
