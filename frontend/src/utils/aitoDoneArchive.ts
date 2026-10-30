import { parseUTCDate, parseUTCDateStrict } from './date';
import type { AitoProject } from '../api/client';

/** The Done archive's own filter and sort rules.
 *
 *  Done is the one place on the board where "what happened" matters more than
 *  "what is next": a declined quote and a shipped, paid job both sit there,
 *  and the card alone does not say which is which. These rules are what the
 *  grid's pills and sort menu apply, kept pure so they can be pinned without
 *  rendering anything. The search is `matchesSearch`'s and runs first; these
 *  run on what it keeps. */

/** One outcome per card, except `all`. The pill order. */
export const DONE_FILTERS = ['all', 'accepted', 'declined', 'unpaid', 'shipped'] as const;
export type DoneFilter = (typeof DONE_FILTERS)[number];

/** The sort menu's entries, in menu order. */
export const DONE_SORTS = ['finishedDesc', 'finishedAsc', 'createdDesc', 'createdAsc', 'amountDesc', 'clientAsc'] as const;
export type DoneSort = (typeof DONE_SORTS)[number];

export const DEFAULT_DONE_SORT: DoneSort = 'finishedDesc';

const SORT_STORAGE_KEY = 'bambuddy-aito-done-sort';

/** Whether a finished card belongs under a filter.
 *
 *  `declined` is the quote status — the same fact the rule engine turns into
 *  `move_lock: 'declined'` (aito_board_rules.evaluate). `accepted` is its
 *  complement rather than `quote_status === 'accepted'`: a hand-made card
 *  carries no quote status, yet it only reaches Done through Accept, so it
 *  IS an accepted job. `unpaid` and `shipped` cut across those two. */
export function doneFilterMatches(project: AitoProject, filter: DoneFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'declined':
      return project.quote_status === 'declined';
    case 'accepted':
      return project.quote_status !== 'declined';
    case 'unpaid':
      return project.invoice_balance !== null && project.invoice_balance > 0;
    case 'shipped':
      return typeof project.shipping_lta === 'string' && project.shipping_lta.trim() !== '';
  }
}

/** How many cards each pill would show, over one list — the grid hands in
 *  the search's survivors so the counts answer "of these". */
export function doneFilterCounts(projects: AitoProject[]): Record<DoneFilter, number> {
  const counts = Object.fromEntries(DONE_FILTERS.map((filter) => [filter, 0])) as Record<DoneFilter, number>;
  for (const project of projects) {
    for (const filter of DONE_FILTERS) {
      if (doneFilterMatches(project, filter)) counts[filter] += 1;
    }
  }
  return counts;
}

// `parseUTCDate`, not a string compare: the board's timestamps are
// inconsistently suffixed ('…:00Z' on some rows, '…:00' on others) and a
// lexical compare orders those two forms by their suffix, not their instant.
const instant = (stamp: string | null) => (stamp ? (parseUTCDate(stamp)?.getTime() ?? 0) : 0);

/** The stamp a finished card is dated by. `done_at` once the server has
 *  written it; `updated_at` for a card whose stamp has not landed yet (the
 *  optimistic window) — never for a card the server says has none. */
export function finishedAt(project: Pick<AitoProject, 'done_at' | 'updated_at'>): string | null {
  return project.done_at ?? project.updated_at;
}

/** Which stamp a date sort reads, or null for a sort that is not a date
 *  (amount, client) — the grid groups by month only when this is non-null.
 *  `dateOf` is the archive's own clock for the finished/deleted dimension:
 *  Done passes `finishedAt`, Trash passes the deletion time. */
export function sortDateOf(
  sort: DoneSort,
  dateOf: (project: AitoProject) => string | null,
): ((project: AitoProject) => string | null) | null {
  switch (sort) {
    case 'finishedDesc':
    case 'finishedAsc':
      return dateOf;
    case 'createdDesc':
    case 'createdAsc':
      return (project) => project.created_at;
    default:
      return null;
  }
}

/** `YYYY-MM` of a stamp in the operator's local time, the month the grid
 *  groups under; null for no stamp or an unparseable one. Local time, like
 *  every date the operator reads on the board: a job finished at 23:30 on
 *  the 31st in Tahiti belongs to that month, not to UTC's next one. */
export function monthGroupKey(stamp: string | null): string | null {
  const date = parseUTCDateStrict(stamp);
  if (!date) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export interface WinLoss {
  won: number;
  lost: number;
  /** Whole percent of accepted over accepted + declined. */
  rate: number;
}

/** Accepted against declined over one set of counts, or null when the set
 *  decides nothing (no quote answered either way). */
export function winLoss(counts: Record<DoneFilter, number>): WinLoss | null {
  const won = counts.accepted;
  const lost = counts.declined;
  if (won + lost === 0) return null;
  return { won, lost, rate: Math.round((won / (won + lost)) * 100) };
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Nulls last whichever way the numbers go. */
function compareNullable(a: number | null, b: number | null, direction: 1 | -1): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return (a - b) * direction;
}

function compareBy(
  sort: DoneSort,
  dateOf: (project: AitoProject) => string | null,
): (a: AitoProject, b: AitoProject) => number {
  switch (sort) {
    case 'finishedDesc':
      return (a, b) => instant(dateOf(b)) - instant(dateOf(a));
    case 'finishedAsc':
      return (a, b) => instant(dateOf(a)) - instant(dateOf(b));
    case 'createdDesc':
      return (a, b) => instant(b.created_at) - instant(a.created_at);
    case 'createdAsc':
      return (a, b) => instant(a.created_at) - instant(b.created_at);
    case 'amountDesc':
      return (a, b) => compareNullable(a.quote_total, b.quote_total, -1);
    case 'clientAsc':
      return (a, b) => {
        const nameA = a.client_name?.trim() || null;
        const nameB = b.client_name?.trim() || null;
        if (nameA === null && nameB === null) return 0;
        if (nameA === null) return 1;
        if (nameB === null) return -1;
        return collator.compare(nameA, nameB);
      };
  }
}

/** A sorted copy. Ties break on id descending so the order is stable across
 *  refetches, whatever the primary key. `dateOf` is the finished/deleted
 *  dimension's clock — see `sortDateOf`. */
export function sortDone(
  projects: AitoProject[],
  sort: DoneSort,
  dateOf: (project: AitoProject) => string | null = finishedAt,
): AitoProject[] {
  const compare = compareBy(sort, dateOf);
  return projects.slice().sort((a, b) => compare(a, b) || b.id - a.id);
}

function isDoneSort(value: string | null): value is DoneSort {
  return value !== null && (DONE_SORTS as readonly string[]).includes(value);
}

/** The operator's last sort choice, or the default. Storage can be absent or
 *  throw (private windows, blocked site data); either reads as the default. */
export function readDoneSort(): DoneSort {
  try {
    const saved = localStorage.getItem(SORT_STORAGE_KEY);
    return isDoneSort(saved) ? saved : DEFAULT_DONE_SORT;
  } catch {
    return DEFAULT_DONE_SORT;
  }
}

export function writeDoneSort(sort: DoneSort): void {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, sort);
  } catch {
    // A preference, not state: losing it costs one click next time.
  }
}
