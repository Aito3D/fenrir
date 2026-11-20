import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api, type UiPrefs } from '../../api/client';
import { FOLLOW_KEYS } from './orderBoard';
import type { FollowKey, PayFilter, SortKey, StatusFilter } from './orderBoard';
import { STATUSES } from './orderStatus';

const STATUS_VALUES: StatusFilter[] = ['all', ...STATUSES, 'finished'];
const PAY_VALUES: PayFilter[] = ['all', 'unpaid', 'partial', 'paid', 'overdue'];
export const SORTS: SortKey[] = ['age', 'value', 'customer', 'ready'];

const pick = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

const fromUrl = (params: URLSearchParams) => ({
  query: params.get('q') ?? '',
  status: pick(params.get('status'), STATUS_VALUES, 'all'),
  payFilter: pick(params.get('pay'), PAY_VALUES, 'all'),
  follow: (FOLLOW_KEYS as string[]).includes(params.get('follow') ?? '') ? (params.get('follow') as FollowKey) : null,
  sort: { key: pick(params.get('sort'), SORTS, 'age'), flipped: params.get('flip') === '1' },
});

const CORE_ONLY_KEY = 'orders.coreOnly';
const PREF_KEY = 'orders';
const PREFS_QUERY = ['ui-prefs'];
const URL_FILTERS = ['pay', 'follow', 'sort', 'flip'];

/** The board's sort and filters as the account keeps them (`PUT /users/me/ui-prefs/orders`). */
interface OrderPrefs {
  pay?: string;
  follow?: string | null;
  sort?: string;
  flip?: boolean;
  coreOnly?: boolean;
}

// "3D only" is on unless the viewer turned it off. This browser's copy covers the moment before the
// account's answer, and auth-off installs, which have no account. Storage can throw (private windows).
function readCoreOnly(): boolean {
  try {
    return localStorage.getItem(CORE_ONLY_KEY) !== 'false';
  } catch {
    return true;
  }
}

/** The board's filters, mirrored into the URL (`q`, `status`, `pay`, `follow`, `sort`, `flip`) with defaults left out.
 *  State is local and the URL follows with `replace`, so typing neither lags nor fills the history; other
 *  parameters (`?order=`) are kept. A URL changed by anything else (a link to bare /orders, back/forward) is
 *  copied into the state.
 *  "3D only", the payment and follow-up filters and the sort are saved on the user's account when the viewer
 *  picks them, and come back on a visit whose URL names none of them. `setCoreOnly` is the page's own
 *  temporary switch (to show an order it opens) and saves nothing; `chooseCoreOnly` is the viewer's. */
export function useOrderFilters() {
  const [params, setParams] = useSearchParams();
  const [initial] = useState(() => fromUrl(params));
  const [query, setQuery] = useState(initial.query);
  const [status, setStatus] = useState(initial.status);
  const [payFilter, setPayFilter] = useState(initial.payFilter);
  const [follow, setFollow] = useState<FollowKey | null>(initial.follow);
  const [sort, setSort] = useState<{ key: SortKey; flipped: boolean }>(initial.sort);
  const [coreOnly, setCoreOnly] = useState(readCoreOnly);
  const queryClient = useQueryClient();
  const prefs = useQuery({ queryKey: PREFS_QUERY, queryFn: api.getUiPrefs, staleTime: Infinity });
  const saved = useRef<OrderPrefs | null>(null);
  // Picks made before the account's answer: merged over it once it arrives, never PUT alone (a PUT replaces `orders`).
  const pending = useRef<OrderPrefs | null>(null);
  const readFailed = useRef(false); // a failed read never becomes a write of a partial copy
  const [urlNamedFilters] = useState(() => URL_FILTERS.some(k => params.has(k)));
  useEffect(() => {
    if (saved.current || !(prefs.isSuccess || prefs.isError)) return;
    const mine = (prefs.data?.[PREF_KEY] ?? {}) as OrderPrefs;
    const queued = pending.current;
    pending.current = null;
    readFailed.current = prefs.isError;
    if (queued) {
      // the viewer already chose: their picks stay on screen, the account's other keys are kept as they are
      saved.current = prefs.isError ? {} : { ...mine, ...queued };
      if (!prefs.isError) {
        queryClient.setQueryData<UiPrefs>(PREFS_QUERY, d => ({ ...d, [PREF_KEY]: saved.current }));
        api.putUiPref(PREF_KEY, saved.current).catch(() => {});
      }
      return;
    }
    saved.current = mine;
    if (typeof mine.coreOnly === 'boolean') setCoreOnly(mine.coreOnly);
    if (urlNamedFilters) return; // a link that names its filters shows them
    if (mine.pay) setPayFilter(pick(mine.pay, PAY_VALUES, 'all'));
    if (mine.follow !== undefined) setFollow((FOLLOW_KEYS as string[]).includes(mine.follow ?? '') ? (mine.follow as FollowKey) : null);
    if (mine.sort) setSort({ key: pick(mine.sort, SORTS, 'age'), flipped: !!mine.flip });
  }, [prefs.isSuccess, prefs.isError, prefs.data, urlNamedFilters, queryClient]);

  const persist = (patch: OrderPrefs) => {
    if (!saved.current) {
      pending.current = { ...pending.current, ...patch };
      return;
    }
    const next = { ...saved.current, ...patch };
    saved.current = next;
    queryClient.setQueryData<UiPrefs>(PREFS_QUERY, d => ({ ...d, [PREF_KEY]: next }));
    if (readFailed.current) return;
    api.putUiPref(PREF_KEY, next).catch(() => {}); // unsaved, the choice still holds for this visit
  };
  const choosePayFilter = (value: PayFilter) => {
    setPayFilter(value);
    persist({ pay: value });
  };
  const chooseFollow = (value: FollowKey | null) => {
    setFollow(value);
    persist({ follow: value });
  };
  const chooseSort = (value: { key: SortKey; flipped: boolean }) => {
    setSort(value);
    persist({ sort: value.key, flip: value.flipped });
  };
  const chooseCoreOnly = (value: boolean) => {
    setCoreOnly(value);
    try {
      localStorage.setItem(CORE_ONLY_KEY, String(value));
    } catch {
      // the account copy below still keeps it
    }
    persist({ coreOnly: value });
  };
  // The search string this hook last wrote or followed: any other one came from outside.
  const known = useRef<string | null>(null);
  // Strings of our own writes the router may not have committed yet (it commits in a transition, so a fast
  // keystroke renders against the old URL, and the older write lands after a newer one): not outside changes.
  const inflight = useRef(new Set<string>());

  useEffect(() => {
    const current = params.toString();
    if (known.current !== null && current !== known.current && !inflight.current.has(current)) {
      known.current = current;
      inflight.current.clear();
      const f = fromUrl(params);
      setQuery(f.query);
      setStatus(f.status);
      setPayFilter(f.payFilter);
      setFollow(f.follow);
      setSort(s => (s.key === f.sort.key && s.flipped === f.sort.flipped ? s : f.sort));
      return;
    }
    const next = new URLSearchParams(params);
    const put = (key: string, value: string | null) => (value ? next.set(key, value) : next.delete(key));
    put('q', query || null);
    put('status', status === 'all' ? null : status);
    put('pay', payFilter === 'all' ? null : payFilter);
    put('follow', follow);
    put('sort', sort.key === 'age' ? null : sort.key);
    put('flip', sort.flipped ? '1' : null);
    known.current = next.toString();
    if (known.current !== current) {
      inflight.current.add(current).add(known.current);
      setParams(next, { replace: true });
    } else inflight.current.clear();
  }, [query, status, payFilter, follow, sort, params, setParams]);

  return {
    query, setQuery, status, setStatus,
    payFilter, setPayFilter: choosePayFilter,
    follow, setFollow: chooseFollow,
    sort, setSort: chooseSort,
    coreOnly, setCoreOnly, chooseCoreOnly,
  };
}
