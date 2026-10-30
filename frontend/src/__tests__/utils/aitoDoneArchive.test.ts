/**
 * The Done archive's filter and sort rules, apart from the grid that renders
 * them. Pure functions over `AitoProject`, so the fixtures below only set the
 * fields each rule reads.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DONE_FILTERS,
  DONE_SORTS,
  doneFilterCounts,
  doneFilterMatches,
  finishedAt,
  monthGroupKey,
  readDoneSort,
  sortDateOf,
  sortDone,
  winLoss,
  writeDoneSort,
} from '../../utils/aitoDoneArchive';
import type { AitoProject } from '../../api/client';

const card = (over: Partial<AitoProject> = {}): AitoProject =>
  ({
    id: 1,
    description: 'Card',
    client_name: null,
    quote_status: 'accepted',
    quote_total: null,
    invoice_balance: null,
    shipping_lta: null,
    done_at: null,
    created_at: '2026-07-01T10:00:00Z',
    updated_at: '2026-07-01T10:00:00Z',
    ...over,
  }) as AitoProject;

describe('doneFilterMatches', () => {
  it('"all" keeps everything', () => {
    expect(doneFilterMatches(card({ quote_status: 'declined' }), 'all')).toBe(true);
    expect(doneFilterMatches(card(), 'all')).toBe(true);
  });

  it('"declined" is the declined quote status and nothing else', () => {
    expect(doneFilterMatches(card({ quote_status: 'declined' }), 'declined')).toBe(true);
    expect(doneFilterMatches(card({ quote_status: 'accepted' }), 'declined')).toBe(false);
    expect(doneFilterMatches(card({ quote_status: null }), 'declined')).toBe(false);
  });

  it('"accepted" is every finished job that was not declined — hand-made cards included', () => {
    expect(doneFilterMatches(card({ quote_status: 'accepted' }), 'accepted')).toBe(true);
    expect(doneFilterMatches(card({ quote_status: null }), 'accepted')).toBe(true);
    expect(doneFilterMatches(card({ quote_status: 'declined' }), 'accepted')).toBe(false);
  });

  it('"unpaid" is a positive invoice balance', () => {
    expect(doneFilterMatches(card({ invoice_balance: 12.5 }), 'unpaid')).toBe(true);
    expect(doneFilterMatches(card({ invoice_balance: 0 }), 'unpaid')).toBe(false);
    expect(doneFilterMatches(card({ invoice_balance: null }), 'unpaid')).toBe(false);
  });

  it('"shipped" is an air waybill on the card', () => {
    expect(doneFilterMatches(card({ shipping_lta: 'LTA-42' }), 'shipped')).toBe(true);
    expect(doneFilterMatches(card({ shipping_lta: '  ' }), 'shipped')).toBe(false);
    expect(doneFilterMatches(card({ shipping_lta: null }), 'shipped')).toBe(false);
  });
});

describe('doneFilterCounts', () => {
  it('counts every filter over the same list', () => {
    const counts = doneFilterCounts([
      card({ id: 1, quote_status: 'declined' }),
      card({ id: 2, invoice_balance: 5, shipping_lta: 'L1' }),
      card({ id: 3 }),
    ]);
    expect(counts).toEqual({ all: 3, accepted: 2, declined: 1, unpaid: 1, shipped: 1 });
    expect(Object.keys(counts)).toEqual(DONE_FILTERS);
  });
});

describe('sortDone', () => {
  const rows = [
    card({ id: 1, client_name: 'Moana', quote_total: 50, created_at: '2026-07-03T10:00:00Z', updated_at: '2026-07-10T10:00:00Z' }),
    card({ id: 2, client_name: 'ACME', quote_total: null, created_at: '2026-07-01T10:00:00Z', updated_at: '2026-07-20T10:00:00Z' }),
    card({ id: 3, client_name: 'Élodie', quote_total: 120, created_at: '2026-07-02T10:00:00Z', updated_at: '2026-07-15T10:00:00' }),
  ];
  const ids = (sorted: AitoProject[]) => sorted.map((p) => p.id);

  it('never mutates its input', () => {
    const copy = rows.slice();
    sortDone(rows, 'finishedAsc');
    expect(rows).toEqual(copy);
  });

  it('finished: by updated_at, both ways, bare and Z-suffixed stamps alike', () => {
    expect(ids(sortDone(rows, 'finishedDesc'))).toEqual([2, 3, 1]);
    expect(ids(sortDone(rows, 'finishedAsc'))).toEqual([1, 3, 2]);
  });

  it('finished: done_at outranks updated_at once the server has stamped it', () => {
    const stamped = [
      // Touched yesterday by a sweep, finished in June: sorts as June.
      card({ id: 1, done_at: '2026-06-01T10:00:00Z', updated_at: '2026-07-30T10:00:00Z' }),
      // Not stamped yet (optimistic window): its updated_at stands in.
      card({ id: 2, done_at: null, updated_at: '2026-07-10T10:00:00Z' }),
    ];
    expect(ids(sortDone(stamped, 'finishedDesc'))).toEqual([2, 1]);
    expect(finishedAt(stamped[0])).toBe('2026-06-01T10:00:00Z');
    expect(finishedAt(stamped[1])).toBe('2026-07-10T10:00:00Z');
  });

  it('finished: the trash hands in its own clock', () => {
    const deleted = [
      card({ id: 1, done_at: '2026-06-01T10:00:00Z', updated_at: '2026-07-30T10:00:00Z' }),
      card({ id: 2, done_at: null, updated_at: '2026-07-10T10:00:00Z' }),
    ];
    expect(ids(sortDone(deleted, 'finishedDesc', (p) => p.updated_at))).toEqual([1, 2]);
  });

  it('created: by created_at, both ways', () => {
    expect(ids(sortDone(rows, 'createdDesc'))).toEqual([1, 3, 2]);
    expect(ids(sortDone(rows, 'createdAsc'))).toEqual([2, 3, 1]);
  });

  it('amount: highest quote first, cards without a quote last', () => {
    expect(ids(sortDone(rows, 'amountDesc'))).toEqual([3, 1, 2]);
  });

  it('client: alphabetical ignoring accents and case, nameless cards last', () => {
    const withNameless = [...rows, card({ id: 4, client_name: null })];
    expect(ids(sortDone(withNameless, 'clientAsc'))).toEqual([2, 3, 1, 4]);
  });

  it('breaks every tie on id descending so the order is stable', () => {
    const same = [card({ id: 1 }), card({ id: 3 }), card({ id: 2 })];
    for (const sort of DONE_SORTS) {
      expect(ids(sortDone(same, sort))).toEqual([3, 2, 1]);
    }
  });
});

describe('sort preference', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to newest finished first', () => {
    expect(readDoneSort()).toBe('finishedDesc');
  });

  it('round-trips a saved choice', () => {
    writeDoneSort('clientAsc');
    expect(readDoneSort()).toBe('clientAsc');
  });

  it('ignores a value it does not know', () => {
    localStorage.setItem('bambuddy-aito-done-sort', 'bogus');
    expect(readDoneSort()).toBe('finishedDesc');
  });
});

describe('sortDateOf', () => {
  const clock = (p: AitoProject) => p.updated_at;
  it('is the archive clock for the finished sorts and created_at for the created ones', () => {
    expect(sortDateOf('finishedDesc', clock)).toBe(clock);
    expect(sortDateOf('finishedAsc', clock)).toBe(clock);
    expect(sortDateOf('createdDesc', clock)!(card({ created_at: '2026-01-02T00:00:00Z' }))).toBe('2026-01-02T00:00:00Z');
  });
  it('is null for the sorts that are not dates, so the grid does not group', () => {
    expect(sortDateOf('amountDesc', clock)).toBeNull();
    expect(sortDateOf('clientAsc', clock)).toBeNull();
  });
});

describe('monthGroupKey', () => {
  it('reads the month in local time', () => {
    const local = new Date(2026, 8, 30, 23, 30); // 30 Sep 2026, 23:30 local
    expect(monthGroupKey(local.toISOString())).toBe('2026-09');
  });
  it('is null without a stamp', () => {
    expect(monthGroupKey(null)).toBeNull();
    expect(monthGroupKey('not a date')).toBeNull();
  });
});

describe('winLoss', () => {
  it('is accepted against declined, as a whole percent', () => {
    expect(winLoss({ all: 6, accepted: 4, declined: 2, unpaid: 0, shipped: 0 })).toEqual({ won: 4, lost: 2, rate: 67 });
  });
  it('is null when nothing was decided either way', () => {
    expect(winLoss({ all: 0, accepted: 0, declined: 0, unpaid: 0, shipped: 0 })).toBeNull();
  });
});
