import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { PayFilter, SortKey, StatusFilter } from './orderBoard';
import { STATUSES } from './orderStatus';

const STATUS_VALUES: StatusFilter[] = ['all', ...STATUSES];
const PAY_VALUES: PayFilter[] = ['all', 'unpaid', 'partial', 'paid', 'overdue'];
export const SORTS: SortKey[] = ['age', 'value', 'customer', 'ready'];

const pick = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

/** The board's filters, mirrored into the URL (`q`, `status`, `pay`, `sort`, `flip`) with defaults left out.
 *  State is local and the URL follows with `replace`, so typing neither lags nor fills the history; other
 *  parameters (`?order=`) are kept. */
export function useOrderFilters() {
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(() => params.get('q') ?? '');
  const [status, setStatus] = useState(() => pick(params.get('status'), STATUS_VALUES, 'all'));
  const [payFilter, setPayFilter] = useState(() => pick(params.get('pay'), PAY_VALUES, 'all'));
  const [sort, setSort] = useState<{ key: SortKey; flipped: boolean }>(() => ({
    key: pick(params.get('sort'), SORTS, 'age'),
    flipped: params.get('flip') === '1',
  }));

  useEffect(() => {
    const next = new URLSearchParams(params);
    const put = (key: string, value: string | null) => (value ? next.set(key, value) : next.delete(key));
    put('q', query || null);
    put('status', status === 'all' ? null : status);
    put('pay', payFilter === 'all' ? null : payFilter);
    put('sort', sort.key === 'age' ? null : sort.key);
    put('flip', sort.flipped ? '1' : null);
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
  }, [query, status, payFilter, sort, params, setParams]);

  return { query, setQuery, status, setStatus, payFilter, setPayFilter, sort, setSort };
}
