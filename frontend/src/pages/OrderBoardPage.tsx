import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Box, Loader2, PackageCheck, Plug, PowerOff, RefreshCw, Search, SearchX } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '../api/client';
import type { OrderBoardResponse, OrderBoardRow } from '../api/client';
import { Button } from '../components/Button';
import { Skeleton } from '../components/Skeleton';
import { FinishedOrderCard } from '../components/orders/FinishedOrderCard';
import { OrderCard } from '../components/orders/OrderCard';
import {
  byBrand,
  byFinishedPayment,
  byPayment,
  bySearch,
  byStatus,
  countByPayment,
  countByStatus,
  finishedByBrand,
  isBoardReady,
  otherOpenOrders,
  paidPct,
  pollMs,
  searchFinished,
  sortRows,
  totalValue,
  withFinished,
} from '../components/orders/orderBoard';
import type { PayFilter, StatusFilter } from '../components/orders/orderBoard';
import { SORTS, useOrderFilters } from '../components/orders/useOrderFilters';
import { STATUSES, STATUS_META, TONE } from '../components/orders/orderStatus';
import type { Tone } from '../components/orders/orderStatus';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { formatDateTime } from '../utils/date';
import { prefersReducedMotion } from '../utils/motion';
import { formatMoney } from '../utils/pricing';

const BOARD_KEY = ['order-board'] as const;
const FINISHED_KEY = ['order-board', 'finished'] as const;
const PAGE = 50;
const PAY_CHIPS: Exclude<PayFilter, 'all' | 'overdue'>[] = ['unpaid', 'partial', 'paid'];
const CORE_ONLY_KEY = 'orders.coreOnly';

const chipCls = (active: boolean) =>
  `rounded-full border px-3 py-1.5 text-xs ${active ? 'border-bambu-green bg-bambu-green/15 text-white' : 'border-bambu-dark-tertiary bg-bambu-dark-secondary text-bambu-gray hover:text-white'}`;

// "3D only" is on unless the viewer turned it off. Storage can throw (private
// windows, blocked site data); the page must render without it.
function readCoreOnly(): boolean {
  try {
    return localStorage.getItem(CORE_ONLY_KEY) !== 'false';
  } catch {
    return true;
  }
}

function remember(key: string, value: boolean) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // remembered for this visit only
  }
}

function Notice({ icon: Icon, title, hint }: { icon: LucideIcon; title: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-bambu-dark-tertiary px-6 py-12 text-center">
      <Icon aria-hidden="true" className="mx-auto h-8 w-8 text-bambu-gray" />
      <div className="mt-3 font-medium text-white">{title}</div>
      {hint && <div className="mt-1 text-sm text-bambu-gray">{hint}</div>}
    </div>
  );
}

/** Which open sales orders can ship today, and what holds back the others.
 *  The list is read from the stored board (one local read, polled). The opened order
 *  runs the fulfilment steps that write to Zoho Books (picklist, parcel, hand-over,
 *  invoice) through OrderLinesPanel / useOrderActions. */
export function OrderBoardPage() {
  const { t, i18n } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const { data, isError, refetch } = useQuery<OrderBoardResponse>({
    queryKey: BOARD_KEY,
    queryFn: api.getOrderBoard,
    // A background refresh swaps the numbers in place: the last data stays on screen.
    refetchInterval: query => pollMs(query.state.data),
  });
  const refresh = useMutation({
    mutationFn: api.refreshOrderBoard,
    onSuccess: fresh => {
      queryClient.setQueryData(BOARD_KEY, fresh);
      void queryClient.invalidateQueries({ queryKey: FINISHED_KEY, exact: true });
    },
    onError: () => showToast(t('orders.refreshFailed'), 'error'),
  });

  const { query, setQuery, status, setStatus, payFilter, setPayFilter, sort, setSort } = useOrderFilters();
  const [coreOnly, setCoreOnly] = useState(readCoreOnly);
  const [shown, setShown] = useState(PAGE);
  const [start, setStart] = useState<{ id: string; target: string; tick: number } | null>(null);
  const scrollTarget = useRef<{ id: string; block: ScrollLogicalPosition } | null>(null);
  // One order is open at a time and the URL says which (`?order=`): a copied address or Back lands on it.
  const [searchParams, setSearchParams] = useSearchParams();
  const openId = searchParams.get('order');
  // The `?order=` this page already acted on: its own clicks, or a link it has followed.
  const deepLinked = useRef<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const finishedQuery = useQuery({ queryKey: FINISHED_KEY, queryFn: api.getFinishedOrders });

  // Opening adds a history entry (Back closes it); closing replaces, so Back never reopens what was just closed.
  const setOrder = (id: string | null, clearFilters = false) => {
    deepLinked.current = id;
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (id) next.set('order', id);
      else next.delete('order');
      if (clearFilters) for (const key of ['q', 'status', 'pay']) next.delete(key);
      return next;
    }, { replace: !id });
  };

  // `/` goes to the search box, `j` / `k` walk the order rows (Enter opens the focused one, as any button).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const at = e.target instanceof Element ? e.target : null;
      if (e.ctrlKey || e.metaKey || e.altKey || at?.closest('input, textarea, select, [contenteditable], [role="dialog"]')) return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'j' || e.key === 'k') {
        const rows = [...document.querySelectorAll<HTMLElement>('[data-order-row]')];
        // From inside an opened order, the walk continues from that order's row.
        const here = document.activeElement?.closest('[id^="order-"]')?.querySelector<HTMLElement>('[data-order-row]');
        const index = here ? rows.indexOf(here) + (e.key === 'j' ? 1 : -1) : 0;
        rows[Math.max(0, Math.min(rows.length - 1, index))]?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const toggleCoreOnly = () => {
    const next = !coreOnly;
    setCoreOnly(next);
    remember(CORE_ONLY_KEY, next);
  };
  // "Also open for this customer": the filters go (in the URL, the filter state follows it) so the target is listed.
  const goto = (id: string) => {
    // Turned off for this visit only: the saved choice stays as the viewer set it.
    if (coreOnly && !data?.rows.find(r => r.id === id)?.is_core) setCoreOnly(false);
    setOrder(id, true);
    scrollTarget.current = { id, block: 'start' };
  };
  const toggleOpen = (id: string) => {
    // A closed order forgets the step it was opened on, so opening it again does not bring the bar back.
    setStart(null);
    // The order that was open folds away above: keep the one just opened on screen.
    if (openId !== id) scrollTarget.current = { id, block: 'nearest' };
    setOrder(openId === id ? null : id);
  };

  const ready = isBoardReady(data);
  // The rows rise in once, when the board first shows; filters and refreshes later swap them in place.
  const [entering, setEntering] = useState(true);
  useEffect(() => {
    if (!ready || !entering) return;
    const id = setTimeout(() => setEntering(false), 700);
    return () => clearTimeout(id);
  }, [ready, entering]);
  // A `?order=` that came from outside (a link, Back): show what would hide the order, then scroll to it. An unknown id does nothing.
  useEffect(() => {
    if (deepLinked.current === openId || !ready) return;
    const row = openId ? data?.rows.find(r => r.id === openId) : null;
    const fin = openId && !row ? finishedQuery.data?.rows.find(r => r.id === openId) : null;
    if (openId && !row && !fin && finishedQuery.isLoading) return; // it may be a finished order: wait for that list
    deepLinked.current = openId;
    if (!openId || (!row && !fin)) return;
    // Turned off for this visit only: the saved choice stays as the viewer set it.
    if (coreOnly && (row ?? fin)?.is_core === false) setCoreOnly(false);
    if (fin) setStatus('finished');
    else if (status === 'finished') setStatus('all');
    scrollTarget.current = { id: openId, block: 'start' };
  }, [openId, ready, data, finishedQuery.data, finishedQuery.isLoading, coreOnly, status, setStatus]);
  // After the target renders, bring it into view. Declared after the effect above, so one pass does both.
  useEffect(() => {
    const target = scrollTarget.current;
    const el = target ? document.getElementById(`order-${target.id}`) : null;
    if (!target || !el) return;
    scrollTarget.current = null;
    el.scrollIntoView?.({ block: target.block, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  });
  const all = useMemo(() => (ready && data ? data.rows : []), [ready, data]);
  // Each customer's open orders, built once per board instead of a scan per card.
  const byCustomer = useMemo(() => {
    const map = new Map<string, OrderBoardRow[]>();
    for (const r of all) if (r.customer_id) map.set(r.customer_id, [...(map.get(r.customer_id) ?? []), r]);
    return map;
  }, [all]);
  // Typing stays responsive: the list follows the search box a beat behind.
  const searchText = useDeferredValue(query);
  // Tiles follow the brand toggle and the search; the list adds the status tile and the payment chip.
  const branded = byBrand(all, coreOnly);
  const searched = bySearch(branded, searchText);
  // Finished orders have a tile of their own and never mix with the open ones.
  const finishedSearched = searchFinished(finishedByBrand(finishedQuery.data?.rows ?? [], coreOnly), searchText);
  const finishedFound = status === 'finished' ? finishedSearched : [];
  const payCounts = countByPayment(status === 'finished' ? [] : searched);
  for (const f of PAY_CHIPS) payCounts[f] += byFinishedPayment(finishedFound, f).length;
  payCounts.all += finishedFound.length;
  // Overdue only while something open is overdue.
  const showOverdue = payCounts.overdue > 0;
  const pay: PayFilter = payFilter === 'overdue' && !showOverdue ? 'all' : payFilter;
  const listed = sortRows(
    withFinished(byPayment(byStatus(searched, status), pay), byFinishedPayment(finishedFound, pay)),
    sort.key,
    // Finished orders read newest first by default: the oldest are years old.
    sort.flipped !== (status === 'finished' && sort.key === 'age'),
    i18n.language,
  );
  const tileCounts = countByStatus(searched);
  tileCounts.finished = finishedSearched.length;
  // Orders counted under "To order" that sit under Partial: the tiles add up to more than the total because of them.
  const partialToOrder = searched.filter(r => r.status !== 'to_order' && r.units.to_order > 0).length;
  // A count ticks when it moves away from what the board first showed, never on the page's own entrance.
  const firstCounts = useRef<typeof tileCounts | null>(null);
  if (ready && !firstCounts.current && !searchText.trim()) firstCounts.current = tileCounts;
  const hidden = all.length - branded.length;
  const syncing = !!data && (data.sync.running || data.sync.pending > 0);

  const tile = (id: StatusFilter, label: string, hint: string, tone: Tone) => (
    <button
      key={id}
      type="button"
      aria-pressed={status === id}
      title={id === 'all' || id === 'finished' ? undefined : t(STATUS_META[id].hint)}
      onClick={() => setStatus(status === id ? 'all' : id)}
      className={`rounded-xl border border-l-4 border-bambu-dark-tertiary bg-bambu-dark-secondary px-4 py-3 text-left hover:bg-bambu-dark-tertiary/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green ${TONE[tone].edge} ${status === id ? 'ring-2 ring-bambu-green/60' : ''}`}
    >
      <span className="block text-xs text-bambu-gray">{label}</span>{' '}
      {ready && !(id === 'finished' && finishedQuery.isLoading) ? (
        <span key={tileCounts[id]} className={`mt-1 block text-2xl font-bold ${id === 'all' ? 'text-white' : TONE[tone].text} ${id !== 'finished' && !searchText.trim() && tileCounts[id] !== firstCounts.current?.[id] ? 'animate-value-tick' : ''}`}>{tileCounts[id]}</span>
      ) : (
        <Skeleton className="mt-2 h-7 w-12 rounded-md" />
      )}{' '}
      <span className="mt-0.5 block truncate text-xs text-bambu-gray">{ready ? hint : ' '}</span>
    </button>
  );

  // Order value and share paid; null when there is no order to add up.
  const moneyLine = (rows: OrderBoardRow[]): string | null => {
    if (!rows.length) return null;
    const share = paidPct(rows);
    return formatMoney(totalValue(rows), rows[0].currency) + (share === null ? '' : ` · ${t('orders.pay.tile', { pct: share })}`);
  };

  let list: ReactNode;
  if (isError && !data) {
    list = (
      <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-6 py-10 text-center">
        <div className="font-medium text-white">{t('orders.loadFailed')}</div>
        <Button variant="secondary" size="sm" className="mt-4" onClick={() => refetch()}>
          {t('orders.retry')}
        </Button>
      </div>
    );
  } else if (!ready && data && !data.sync.enabled) {
    list = <Notice icon={PowerOff} title={t('orders.syncOff')} hint={t('orders.syncOffHint')} />;
  } else if (!ready && data && !data.sync.configured) {
    list = <Notice icon={Plug} title={t('orders.notConnected')} hint={t('orders.notConnectedHint')} />;
  } else if (!ready) {
    // Never an empty or all-red board here: nothing has been verified yet.
    list = (
      <>
        {data && (
          <div className="flex items-center gap-2 text-sm text-bambu-gray">
            <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
            {t('orders.firstSync', { n: data.sync.pending })}
          </div>
        )}
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-16 rounded-xl" />
        ))}
      </>
    );
  } else if (status === 'finished' && finishedQuery.isLoading) {
    list = Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-16 rounded-xl" />);
  } else if (listed.length === 0 && all.length === 0 && status !== 'finished') {
    list = <Notice icon={PackageCheck} title={t('orders.empty.none')} hint={t('orders.empty.noneHint')} />;
  } else if (listed.length === 0 && coreOnly && branded.length === 0 && !searchText.trim() && status === 'all') {
    list = <Notice icon={Box} title={t('orders.empty.core')} hint={t('orders.empty.coreHint')} />;
  } else if (listed.length === 0) {
    list = <Notice icon={SearchX} title={t('orders.empty.noResults')} />;
  } else {
    // An opened order always renders, even past the page: a `?order=` link or "Also open" may target one further down.
    list = listed.filter((e, i) => i < shown || (e.open ? e.open.id : e.fin.id) === openId).map(({ open: row, fin }) => !row ? (
      <FinishedOrderCard key={fin.id} row={fin} open={openId === fin.id} onToggle={() => toggleOpen(fin.id)} />
    ) : (
      <OrderCard
        key={row.id}
        row={row}
        open={openId === row.id}
        onToggle={() => toggleOpen(row.id)}
        others={otherOpenOrders(byCustomer.get(row.customer_id) ?? [], row).map(o => ({ id: o.id, number: o.number }))}
        onGoto={goto}
        onStart={target => {
          if (openId !== row.id) setOrder(row.id);
          setStart(s => ({ id: row.id, target, tick: (s?.tick ?? 0) + 1 }));
        }}
        start={start?.id === row.id ? start.target : undefined}
        startTick={start?.id === row.id ? start.tick : undefined}
      />
    ));
  }

  return (
    <div className="p-4 md:p-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 animate-rise-lg vt-page-title">
        <h1 className="flex items-center gap-3 text-2xl font-bold text-white max-md:hidden">
          <PackageCheck className="h-7 w-7 text-bambu-green" />
          {t('orders.title')}
        </h1>
        <div className="ml-auto flex items-center gap-3">
          {data && (
            <span className="inline-flex items-center gap-2 text-sm text-bambu-gray" role="status">
              {syncing && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
              {syncing
                ? t('orders.syncing', { n: data.sync.pending })
                : data.computed_at && t('orders.updated', { when: formatDateTime(data.computed_at) })}
            </span>
          )}
          {hasPermission('orders:update') && (
            <Button variant="secondary" size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
              <RefreshCw aria-hidden="true" className={`h-4 w-4 ${refresh.isPending ? 'animate-spin' : ''}`} />
              {t('orders.refresh')}
            </Button>
          )}
        </div>
      </div>

      {data?.sync.last_error && (
        <div className="animate-rise-sm mb-5 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-200" role="alert">
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {t('orders.syncFailed', { reason: data.sync.last_error, when: formatDateTime(data.sync.last_success_at ?? data.computed_at) || '–' })}
          </span>
        </div>
      )}

      <div data-testid="orders-tiles" className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        {STATUSES.map(id => tile(
          id,
          t(STATUS_META[id].label),
          (id === 'to_ship' && moneyLine(byStatus(searched, id)))
            || (id === 'to_order' && partialToOrder > 0 && t('orders.hint.toOrderIncl', { n: partialToOrder }))
            || t(STATUS_META[id].hint),
          STATUS_META[id].tone,
        ))}
        {tile('all', t('orders.status.inProgress'), moneyLine(searched) ?? '–', 'neutral')}
        {tile('finished', t('orders.status.finished'), t('orders.hint.finished'), 'neutral')}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative max-w-md grow basis-64">
          <Search aria-hidden="true" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-bambu-gray/50" />
          <input
            ref={searchRef}
            type="search"
            aria-keyshortcuts="/"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t('orders.search')}
            aria-label={t('orders.search')}
            className="w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary py-2 pl-10 pr-3 text-sm text-white placeholder:text-bambu-gray/50 focus:border-bambu-green focus:outline-none"
          />
        </div>
        <button
          type="button"
          aria-pressed={coreOnly}
          onClick={toggleCoreOnly}
          className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${coreOnly ? 'border-bambu-green/50 bg-bambu-green/10 text-bambu-green' : 'border-bambu-dark-tertiary bg-bambu-dark-secondary text-bambu-gray hover:text-white'}`}
        >
          <Box aria-hidden="true" className="h-4 w-4" />
          {t('orders.coreOnly')}
          {coreOnly && hidden > 0 && <span className="text-xs text-bambu-gray">{t('orders.hidden', { n: hidden })}</span>}
        </button>
        <div className="flex flex-wrap items-center gap-1.5">
          {(['all', ...PAY_CHIPS, ...(showOverdue ? ['overdue' as const] : [])] as PayFilter[]).map(id => (
            <button key={id} type="button" aria-pressed={pay === id} onClick={() => setPayFilter(id)} className={chipCls(pay === id)}>
              {id === 'all' ? t('orders.pay.any') : id === 'overdue' ? t('orders.pay.overdueChip') : t(`orders.pay.${id}`)}{' '}
              <span className="text-bambu-gray">{payCounts[id]}</span>
            </button>
          ))}
        </div>
        <div className="ml-auto inline-flex items-center gap-1 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary p-1 text-xs">
          <span className="px-2 text-bambu-gray">{t('orders.sort.label')}</span>
          {SORTS.map(key => {
            const active = sort.key === key;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={active}
                onClick={() => setSort(active ? { key, flipped: !sort.flipped } : { key, flipped: false })}
                className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 ${active ? 'bg-bambu-dark-tertiary text-white' : 'text-bambu-gray hover:text-white'}`}
              >
                {t(`orders.sort.${key}`)}
                {active && <span>{sort.flipped ? '↑' : '↓'}</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div data-testid="orders-list" className={`space-y-2 ${ready && entering ? 'orders-rows-enter stagger-children' : ''}`}>{list}</div>
      {ready && listed.length > shown && (
        <button
          type="button"
          onClick={() => setShown(n => n + PAGE)}
          className="mx-auto mt-2 block rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary px-4 py-2 text-xs text-bambu-gray hover:text-white"
        >
          {t('orders.showMore')}
        </button>
      )}
      {ready && status === 'finished' && finishedQuery.isError && (
        <div className="mt-2 flex items-center justify-center gap-3 text-sm text-bambu-gray">
          {t('orders.finished.loadListFailed')}
          <Button variant="secondary" size="sm" onClick={() => finishedQuery.refetch()}>
            {t('orders.retry')}
          </Button>
        </div>
      )}
    </div>
  );
}
