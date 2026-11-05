import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Archive, Box, Loader2, PackageCheck, Plug, PowerOff, RefreshCw, Search, SearchX } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '../api/client';
import type { FinishedOrderRow, OrderBoardResponse } from '../api/client';
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
  isBoardReady,
  otherOpenOrders,
  paidPct,
  pollMs,
  searchFinished,
  sortRows,
  totalValue,
} from '../components/orders/orderBoard';
import type { PayFilter, SortKey, StatusFilter } from '../components/orders/orderBoard';
import { STATUSES, STATUS_META, TONE } from '../components/orders/orderStatus';
import type { Tone } from '../components/orders/orderStatus';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { formatDateTime } from '../utils/date';
import { formatMoney } from '../utils/pricing';

const BOARD_KEY = ['order-board'] as const;
const FINISHED_KEY = ['order-board', 'finished'] as const;
const FINISHED_PAGE = 50;
const PAY_CHIPS: Exclude<PayFilter, 'all' | 'overdue'>[] = ['unpaid', 'partial', 'paid'];
const CORE_ONLY_KEY = 'orders.coreOnly';
const SORTS: SortKey[] = ['age', 'value', 'customer', 'ready'];

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
 *  Read-only: the board is computed on the server from a local copy of Zoho. */
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

  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [sort, setSort] = useState<{ key: SortKey; flipped: boolean }>({ key: 'age', flipped: false });
  const [coreOnly, setCoreOnly] = useState(readCoreOnly);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [view, setView] = useState<'open' | 'finished'>('open');
  const [payFilter, setPayFilter] = useState<PayFilter>('all');
  const [finishedShown, setFinishedShown] = useState(FINISHED_PAGE);
  const scrollTarget = useRef<string | null>(null);

  const finishedView = view === 'finished';
  const finishedQuery = useQuery({
    queryKey: FINISHED_KEY,
    queryFn: api.getFinishedOrders,
    enabled: finishedView || query.trim() !== '',
  });

  // After "Also open for this customer" renders the target, bring it into view.
  useEffect(() => {
    const id = scrollTarget.current;
    const el = id ? document.getElementById(`order-${id}`) : null;
    if (!el) return;
    scrollTarget.current = null;
    el.scrollIntoView?.({ block: 'start' });
  });

  const toggleCoreOnly = () => {
    const next = !coreOnly;
    setCoreOnly(next);
    try {
      localStorage.setItem(CORE_ONLY_KEY, String(next));
    } catch {
      // remembered for this visit only
    }
  };
  const showOpen = (next: StatusFilter) => {
    setView('open');
    setStatus(next);
  };
  const showFinished = () => {
    setView('finished');
    setFinishedShown(FINISHED_PAGE);
  };
  const goto = (id: string) => {
    setQuery('');
    setStatus('all');
    setPayFilter('all');
    setView('open');
    // Turned off for this visit only: the saved choice stays as the viewer set it.
    if (coreOnly && !data?.rows.find(r => r.id === id)?.is_core) setCoreOnly(false);
    setOpen(prev => new Set(prev).add(id));
    scrollTarget.current = id;
  };
  const toggleOpen = (id: string) =>
    setOpen(prev => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const ready = isBoardReady(data);
  const all = ready && data ? data.rows : [];
  // Tiles follow the brand toggle only; chips add the search; the list adds the status.
  const branded = byBrand(all, coreOnly);
  const searched = bySearch(branded, query);
  const finishedFound: FinishedOrderRow[] = searchFinished(finishedQuery.data?.rows ?? [], query);
  const finishedCounts = Object.fromEntries(['all', ...PAY_CHIPS].map(f => [f, byFinishedPayment(finishedFound, f as PayFilter).length]));
  const payCounts = finishedView ? finishedCounts : countByPayment(searched);
  // Overdue only exists in the open view, and only while something is overdue.
  const showOverdue = !finishedView && payCounts.overdue > 0;
  const pay: PayFilter = payFilter === 'overdue' && !showOverdue ? 'all' : payFilter;
  const listed = sortRows(byPayment(byStatus(searched, status), pay), sort.key, sort.flipped, i18n.language);
  const finishedListed = byFinishedPayment([...finishedFound].sort((a, b) => b.date.localeCompare(a.date)), pay);
  const tileCounts = countByStatus(branded);
  const chipCounts = countByStatus(searched);
  const hidden = all.length - branded.length;
  const syncing = !!data && (data.sync.running || data.sync.pending > 0);

  const tile = (id: StatusFilter, label: string, hint: string, tone: Tone) => (
    <button
      key={id}
      type="button"
      aria-pressed={!finishedView && status === id}
      onClick={() => showOpen(!finishedView && status === id ? 'all' : id)}
      className={`rounded-xl border border-l-4 border-bambu-dark-tertiary bg-bambu-dark-secondary px-4 py-3 text-left hover:bg-bambu-dark-tertiary/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green ${TONE[tone].edge} ${!finishedView && status === id ? 'ring-2 ring-bambu-green/60' : ''}`}
    >
      <span className="block text-xs text-bambu-gray">{label}</span>{' '}
      {ready ? (
        <span className={`mt-1 block text-2xl font-bold ${id === 'all' ? 'text-white' : TONE[tone].text}`}>{tileCounts[id]}</span>
      ) : (
        <Skeleton className="mt-2 h-7 w-12 rounded-md" />
      )}{' '}
      <span className="mt-0.5 block truncate text-xs text-bambu-gray">{ready ? hint : ' '}</span>
    </button>
  );

  const paidShare = paidPct(branded);
  const finishedHint = view === 'open' && ready && query.trim() !== '' ? finishedFound.length : 0;

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
  } else if (finishedView) {
    if (finishedQuery.isError) {
      list = (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-6 py-10 text-center">
          <div className="font-medium text-white">{t('orders.loadFailed')}</div>
          <Button variant="secondary" size="sm" className="mt-4" onClick={() => finishedQuery.refetch()}>
            {t('orders.retry')}
          </Button>
        </div>
      );
    } else if (!finishedQuery.data) {
      list = Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-16 rounded-xl" />);
    } else {
      list = (
        <>
          <div className="flex items-center gap-2 px-1 text-xs text-bambu-gray">
            <Archive aria-hidden="true" className="h-3.5 w-3.5" />
            {t('orders.finished.intro')}
          </div>
          {finishedListed.length === 0 ? (
            <Notice icon={SearchX} title={finishedFound.length === 0 && !query.trim() ? t('orders.finished.none') : t('orders.empty.noResults')} />
          ) : (
            finishedListed
              .slice(0, finishedShown)
              .map(r => <FinishedOrderCard key={r.id} row={r} open={open.has(r.id)} onToggle={() => toggleOpen(r.id)} />)
          )}
          {finishedListed.length > finishedShown && (
            <button
              type="button"
              onClick={() => setFinishedShown(n => n + FINISHED_PAGE)}
              className="mx-auto block rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary px-4 py-2 text-xs text-bambu-gray hover:text-white"
            >
              {t('orders.finished.older')}
            </button>
          )}
        </>
      );
    }
  } else if (all.length === 0) {
    list = <Notice icon={PackageCheck} title={t('orders.empty.none')} hint={t('orders.empty.noneHint')} />;
  } else if (coreOnly && branded.length === 0 && !query.trim() && status === 'all') {
    list = <Notice icon={Box} title={t('orders.empty.core')} hint={t('orders.empty.coreHint')} />;
  } else if (listed.length === 0) {
    // The finished-orders hint below stands in for "No results".
    list = finishedHint > 0 ? null : <Notice icon={SearchX} title={t('orders.empty.noResults')} />;
  } else {
    list = listed.map(row => (
      <OrderCard
        key={row.id}
        row={row}
        open={open.has(row.id)}
        onToggle={() => toggleOpen(row.id)}
        others={otherOpenOrders(all, row).map(o => ({ id: o.id, number: o.number }))}
        onGoto={goto}
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
        <div className="mb-5 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-200" role="alert">
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {t('orders.syncFailed', { reason: data.sync.last_error, when: formatDateTime(data.sync.last_success_at ?? data.computed_at) || '–' })}
          </span>
        </div>
      )}

      <div data-testid="orders-tiles" className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
        {STATUSES.map(id => tile(id, t(STATUS_META[id].label), t(STATUS_META[id].hint), STATUS_META[id].tone))}
        {tile('all', t('orders.status.inProgress'), branded.length ? formatMoney(totalValue(branded), branded[0].currency) + (paidShare === null ? '' : ` · ${t('orders.pay.tile', { pct: paidShare })}`) : '–', 'neutral')}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative max-w-md grow basis-64">
          <Search aria-hidden="true" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-bambu-gray/50" />
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t('orders.search')}
            aria-label={t('orders.search')}
            className="w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary py-2 pl-10 pr-3 text-sm text-white placeholder:text-bambu-gray/50 focus:border-bambu-green focus:outline-none"
          />
        </div>
        {!finishedView && (
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
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          {(['all', ...STATUSES] as StatusFilter[]).map(id => (
            <button key={id} type="button" aria-pressed={!finishedView && status === id} onClick={() => showOpen(id)} className={chipCls(!finishedView && status === id)}>
              {id === 'all' ? t('orders.status.all') : t(STATUS_META[id].label)} <span className="text-bambu-gray">{chipCounts[id]}</span>
            </button>
          ))}
          <span aria-hidden="true" className="mx-1 h-5 w-px bg-bambu-dark-tertiary" />
          <button type="button" aria-pressed={finishedView} onClick={showFinished} className={`inline-flex items-center gap-1.5 ${chipCls(finishedView)}`}>
            <Archive aria-hidden="true" className="h-3.5 w-3.5" />
            {t('orders.finished.chip')}
            {finishedQuery.data && <span className="text-bambu-gray">{finishedFound.length}</span>}
          </button>
        </div>
        {!finishedView && (
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
        )}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {(['all', ...PAY_CHIPS, ...(showOverdue ? ['overdue' as const] : [])] as PayFilter[]).map(id => (
          <button key={id} type="button" aria-pressed={pay === id} onClick={() => setPayFilter(id)} className={chipCls(pay === id)}>
            {id === 'all' ? t('orders.pay.any') : id === 'overdue' ? t('orders.pay.overdueChip') : t(`orders.pay.${id}`)}{' '}
            <span className="text-bambu-gray">{payCounts[id]}</span>
          </button>
        ))}
      </div>

      <div className="space-y-2">{list}</div>
      {finishedHint > 0 && (
        <button
          type="button"
          onClick={showFinished}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-bambu-dark-tertiary px-4 py-3 text-sm text-bambu-gray hover:text-white"
        >
          <Archive aria-hidden="true" className="h-4 w-4" />
          {t('orders.finished.match', { n: finishedHint })} · <span className="text-bambu-green">{t('orders.finished.show')}</span>
        </button>
      )}
    </div>
  );
}
