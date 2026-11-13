import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { PayFilter, SortKey, StatusFilter } from './orderBoard';
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
  sort: { key: pick(params.get('sort'), SORTS, 'age'), flipped: params.get('flip') === '1' },
});

/** The board's filters, mirrored into the URL (`q`, `status`, `pay`, `sort`, `flip`) with defaults left out.
 *  State is local and the URL follows with `replace`, so typing neither lags nor fills the history; other
 *  parameters (`?order=`) are kept. A URL changed by anything else (a link to bare /orders, back/forward) is
 *  copied into the state. */
export function useOrderFilters() {
  const [params, setParams] = useSearchParams();
  const [initial] = useState(() => fromUrl(params));
  const [query, setQuery] = useState(initial.query);
  const [status, setStatus] = useState(initial.status);
  const [payFilter, setPayFilter] = useState(initial.payFilter);
  const [sort, setSort] = useState<{ key: SortKey; flipped: boolean }>(initial.sort);
  // The search string this hook last wrote or followed: any other one came from outside.
  const known = useRef<string | null>(null);

  useEffect(() => {
    const current = params.toString();
    if (known.current !== null && current !== known.current) {
      known.current = current;
      const f = fromUrl(params);
      setQuery(f.query);
      setStatus(f.status);
      setPayFilter(f.payFilter);
      setSort(s => (s.key === f.sort.key && s.flipped === f.sort.flipped ? s : f.sort));
      return;
    }
    const next = new URLSearchParams(params);
    const put = (key: string, value: string | null) => (value ? next.set(key, value) : next.delete(key));
    put('q', query || null);
    put('status', status === 'all' ? null : status);
    put('pay', payFilter === 'all' ? null : payFilter);
    put('sort', sort.key === 'age' ? null : sort.key);
    put('flip', sort.flipped ? '1' : null);
    known.current = next.toString();
    if (known.current !== current) setParams(next, { replace: true });
  }, [query, status, payFilter, sort, params, setParams]);

  return { query, setQuery, status, setStatus, payFilter, setPayFilter, sort, setSort };
}
