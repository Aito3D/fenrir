import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  DEFAULT_DONE_SORT,
  DONE_FILTERS,
  DONE_SORTS,
  readDoneSort,
  writeDoneSort,
  type DoneFilter,
  type DoneSort,
} from '../utils/aitoDoneArchive';

export type AitoView = 'board' | 'done' | 'trash' | 'stats';

const VIEWS: AitoView[] = ['board', 'done', 'trash', 'stats'];

function parseView(value: string | null): AitoView {
  return value !== null && (VIEWS as string[]).includes(value) ? (value as AitoView) : 'board';
}
function parseFilter(value: string | null): DoneFilter {
  return value !== null && (DONE_FILTERS as readonly string[]).includes(value) ? (value as DoneFilter) : 'all';
}
function parseSort(value: string | null): DoneSort | null {
  return value !== null && (DONE_SORTS as readonly string[]).includes(value) ? (value as DoneSort) : null;
}

/** The Aito page's view, and the archives' filter and sort, mirrored into
 *  the URL: `/aito?view=done&filter=declined&sort=amountDesc`.
 *
 *  The board is the working view and a plain `/aito` still lands on it; the
 *  parameters only exist while a detour is open, so a reload or a shared
 *  link brings back the archive exactly as it was looked at — the same
 *  contract `?card=` already keeps for the detail panel. Each parameter is
 *  absent at its default (board, All, newest finished first), so the address
 *  bar stays `/aito` for the ordinary case.
 *
 *  The sort is ALSO remembered in localStorage: the URL wins when it names
 *  one, the preference fills in when it does not. The filter is not
 *  remembered — a filter that survived into the next visit would be the
 *  "(0) over a full grid" lie the follow-up strip guards against — and it is
 *  dropped whenever the view leaves Done. */
export function useAitoViewParams(): {
  view: AitoView;
  setView: (next: AitoView) => void;
  filter: DoneFilter;
  setFilter: (next: DoneFilter) => void;
  sort: DoneSort;
  setSort: (next: DoneSort) => void;
} {
  const [searchParams, setSearchParams] = useSearchParams();
  const [view, setViewState] = useState<AitoView>(() => parseView(searchParams.get('view')));
  const [filter, setFilter] = useState<DoneFilter>(() =>
    parseView(searchParams.get('view')) === 'done' ? parseFilter(searchParams.get('filter')) : 'all',
  );
  const [sort, setSortState] = useState<DoneSort>(() => parseSort(searchParams.get('sort')) ?? readDoneSort());

  const setView = useCallback((next: AitoView) => {
    setViewState(next);
    if (next !== 'done') setFilter('all');
  }, []);

  const setSort = useCallback((next: DoneSort) => {
    setSortState(next);
    writeDoneSort(next);
  }, []);

  const archive = view === 'done' || view === 'trash';
  const wantedView = view === 'board' ? null : view;
  const wantedFilter = view === 'done' && filter !== 'all' ? filter : null;
  const wantedSort = archive && sort !== DEFAULT_DONE_SORT ? sort : null;

  useEffect(() => {
    if (
      searchParams.get('view') === wantedView &&
      searchParams.get('filter') === wantedFilter &&
      searchParams.get('sort') === wantedSort
    ) {
      return;
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [name, wanted] of [
          ['view', wantedView],
          ['filter', wantedFilter],
          ['sort', wantedSort],
        ] as const) {
          if (wanted === null) next.delete(name);
          else next.set(name, wanted);
        }
        return next;
      },
      // Replace, not push: Back leaves the page, it does not step back
      // through every pill that was pressed.
      { replace: true },
    );
  }, [searchParams, setSearchParams, wantedView, wantedFilter, wantedSort]);

  return { view, setView, filter, setFilter, sort, setSort };
}
