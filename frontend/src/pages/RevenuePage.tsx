import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { bearerAuthHeaders } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { Empty, Split } from '../components/aito/stats/primitives';
import { RevenueSegmented } from '../components/revenue/RevenueSegmented';
import { RevenueSyncBanner } from '../components/revenue/RevenueSyncBanner';
import { RevenueFinding, RevenueHero } from '../components/revenue/RevenueHero';
import { RevenuePace } from '../components/revenue/RevenuePace';
import { RevenueChart } from '../components/revenue/RevenueChart';
import { RevenueTable } from '../components/revenue/RevenueTable';
import { RevenueMovers } from '../components/revenue/RevenueMovers';
import { RevenueCustomers } from '../components/revenue/RevenueCustomers';
import { RevenueAnalysis } from '../components/revenue/RevenueAnalysis';
import { RevenueControls as ControlsRow } from '../components/revenue/RevenueControls';
import { RevenueChip, RevenueProductSearch } from '../components/revenue/RevenueProductSearch';
import { useRevenueResource } from '../components/revenue/useRevenueResource';
import { drillDown, shiftWindow } from '../components/revenue/lib/analysis';
import { addToBasket } from '../components/revenue/lib/basket';
import { orgToday, REVENUE_HISTORY_START } from '../components/revenue/lib/dates';
import { filterByKind } from '../components/revenue/lib/products';
import { controlsFromSearch, controlsToSearch } from '../components/revenue/lib/url';
import { focusRingCls } from '../components/formStyles';
import type { StackDimension } from '../components/revenue/lib/chart';
import {
  createSeriesLoader,
  dashboardReady,
  failureMessage,
  filterQuery,
  pollActive,
  readJsonBody,
  REVENUE_POLL,
  REVENUE_STORAGE_KEYS,
  REVENUE_VIEWS,
  restoreStoredControls,
  segmentPanelId,
  segmentTabId,
  seriesQuery,
  shouldFetchProducts,
  startSeriesPoller,
  storedRangeValue,
  toggleInSet,
  type RangeChoice,
  type RevenueView,
} from '../components/revenue/lib/dashboard';
import type { CustomerSegment, ProductsResponse, RevenueGranularity, RevenueKind, RevenueProduct, RevenueResponse, TaxMode } from '../components/revenue/lib/types';

export interface RevenueControls {
  granularity: RevenueGranularity;
  taxMode: TaxMode;
  stack: StackDimension;
  range: RangeChoice;
  kind: RevenueKind | null;
  segment: CustomerSegment | null;
  view: RevenueView;
  brands: ReadonlySet<string>;
  basket: RevenueProduct[];
}

export interface RevenueCan {
  export: boolean;
  scope: boolean;
  targets: boolean;
  notes: boolean;
  sync: boolean;
  customers: boolean;
  margin: boolean;
}

/** What the page hands every panel. */
export interface RevenuePanelProps {
  payload: RevenueResponse;
  controls: RevenueControls;
  setControls: (patch: Partial<RevenueControls>) => void;
  can: RevenueCan;
}

type Zoom = Pick<RevenueControls, 'granularity' | 'range'>;

const VIEW_KEYS: Record<RevenueView, string> = { evolution: 'evolution', clients: 'clients', produits: 'products', saison: 'seasonality' };

/** Restored before the first render and the first request: a linked URL wins, localStorage fills the rest. */
function initialControls(): RevenueControls {
  let stored: ReturnType<typeof restoreStoredControls> = {};
  try {
    stored = restoreStoredControls((k) => localStorage.getItem(k));
  } catch {
    // Storage unavailable (private window): the defaults stand.
  }
  const url = controlsFromSearch(window.location.search);
  return {
    granularity: url.granularity ?? stored.granularity ?? 'month',
    taxMode: url.taxMode ?? stored.taxMode ?? 'ht',
    stack: url.stack ?? stored.stack ?? 'nature',
    range: url.range ?? (stored.preset ? { preset: stored.preset } : { preset: 'default' }),
    kind: url.kind ?? stored.kind ?? null,
    segment: url.segment ?? stored.segment ?? null,
    view: url.view ?? stored.view ?? 'evolution',
    brands: new Set(url.brands ?? []),
    basket: [],
  };
}

function persist(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the choice lasts for this visit only.
  }
}

export function RevenuePage() {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const can: RevenueCan = {
    export: hasPermission('revenue:export'),
    scope: hasPermission('revenue:manage_scope'),
    targets: hasPermission('revenue:manage_targets'),
    notes: hasPermission('revenue:manage_notes'),
    sync: hasPermission('revenue:sync'),
    customers: hasPermission('revenue:view_customers'),
    margin: hasPermission('revenue:view_margin'),
  };

  const [controls, setControlsState] = useState(initialControls);
  // A chart drill-down: a window for this visit only (never stored, never on the URL), with the levels « Retour » pops.
  const [zoom, setZoom] = useState<Zoom | null>(null);
  const [drillStack, setDrillStack] = useState<Zoom[]>([]);
  const setControls = (patch: Partial<RevenueControls>) => {
    setControlsState((c) => ({ ...c, ...patch }));
    if (patch.granularity || patch.range) {
      setZoom(null);
      setDrillStack([]);
    }
    if (patch.granularity) persist(REVENUE_STORAGE_KEYS.granularity, patch.granularity);
    if (patch.taxMode) persist(REVENUE_STORAGE_KEYS.taxMode, patch.taxMode);
    // « Produit » needs a basket, which is never persisted.
    if (patch.stack && patch.stack !== 'item') persist(REVENUE_STORAGE_KEYS.stack, patch.stack);
    if (patch.range) persist(REVENUE_STORAGE_KEYS.range, storedRangeValue(patch.range));
    if ('kind' in patch) persist(REVENUE_STORAGE_KEYS.kind, patch.kind ?? null);
    if ('segment' in patch) persist(REVENUE_STORAGE_KEYS.segment, patch.segment ?? null);
    if (patch.view) persist(REVENUE_STORAGE_KEYS.view, patch.view === 'evolution' ? null : patch.view);
  };
  // What the page may use: a view or segment stored by a user with more rights (shared terminal) falls back.
  const active: RevenueControls = {
    ...controls,
    ...zoom,
    view: controls.view === 'clients' && !can.customers ? 'evolution' : controls.view,
    segment: can.customers ? controls.segment : null,
  };
  const { view } = active;
  const basketIds = active.basket.map((b) => b.itemId);
  // Basket ids from a linked URL, resolved against the products list once it loads.
  const [pendingItems, setPendingItems] = useState(() => controlsFromSearch(window.location.search).items ?? null);

  const [loader] = useState(() => createSeriesLoader(bearerAuthHeaders));
  const [data, setData] = useState<RevenueResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const [rebuildBusy, setRebuildBusy] = useState(false);
  // Read when the next poll is armed; a ref so a new payload never restarts the poller.
  const syncActive = useRef(false);

  const url = seriesQuery({
    granularity: active.granularity,
    range: active.range,
    basketIds,
    brands: active.brands,
    kind: active.kind,
    segment: active.segment,
  });

  // Load, then poll: 4 s while the back-fill runs, 60 s idle, nothing while the tab is hidden.
  useEffect(() => {
    const poller = startSeriesPoller({
      load: async () => {
        try {
          const r = await loader.load(url);
          if (r.status === 'stale') return;
          if (r.status === 'data') {
            syncActive.current = pollActive(r.payload.sync, r.payload.itemsSyncedAt);
            setData(r.payload);
          }
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
        setLoading(false);
      },
      isActive: () => syncActive.current,
      isHidden: () => document.visibilityState === 'hidden',
      onVisibility: (h) => {
        document.addEventListener('visibilitychange', h);
        return () => document.removeEventListener('visibilitychange', h);
      },
      poll: REVENUE_POLL,
    });
    return () => poller.stop();
  }, [loader, url, tick]);

  // The controls live on the URL too, so a view can be bookmarked or sent.
  const search = controlsToSearch({
    granularity: controls.granularity,
    taxMode: active.taxMode,
    stack: active.stack,
    range: controls.range,
    kind: active.kind,
    segment: active.segment,
    view: active.view,
    brands: active.brands,
    items: pendingItems ?? basketIds,
  });
  useEffect(() => {
    if (search !== window.location.search) window.history.replaceState(window.history.state, '', `${window.location.pathname}${search}${window.location.hash}`);
  }, [search]);

  // The products list behind the search box: on mount, then when the cached days or the review decisions move.
  const fetchedDays = data?.sync.fetchedDays;
  const reviewCount = data?.reviewCount;
  const [productsVersion, setProductsVersion] = useState(0);
  const products = useRevenueResource<ProductsResponse>('/api/v1/revenue/products', productsVersion);
  const productList = products.data?.products ?? null;
  const kindProducts = useMemo(() => filterByKind(productList, active.kind), [productList, active.kind]);
  const productsLoaded = useRef(false);
  productsLoaded.current = productList !== null;
  const productsDeps = useRef<{ fetchedDays: number | undefined; reviewCount: number | undefined } | null>(null);
  useEffect(() => {
    const prev = productsDeps.current;
    productsDeps.current = { fetchedDays, reviewCount };
    // The mount fetch is the resource's own first load.
    if (prev && shouldFetchProducts(prev, productsDeps.current, productsLoaded.current)) setProductsVersion((v) => v + 1);
  }, [fetchedDays, reviewCount]);
  useEffect(() => {
    if (products.error) showToast(t('revenue.search.unavailable', { error: products.error }), 'error');
  }, [products.error, showToast, t]);
  useEffect(() => {
    if (!productList || !pendingItems) return;
    const wanted = new Set(pendingItems);
    const linked = productList.filter((x) => wanted.has(x.itemId));
    setPendingItems(null);
    if (linked.length > 0) setControlsState((c) => ({ ...c, basket: linked }));
  }, [productList, pendingItems]);

  const addProducts = (added: RevenueProduct[]) => {
    const { basket, switchToItemStack } = addToBasket(controls.basket, added);
    // The first product added switches the chart to the per-product split.
    setControls(switchToItemStack ? { basket, stack: 'item' } : { basket });
  };

  const today = orgToday();
  const windowAt = (delta: number) => (data ? shiftWindow(data.from, data.to, data.granularity, delta, REVENUE_HISTORY_START, today) : null);
  const shift = (delta: number) => {
    const w = windowAt(delta);
    // Stepping out of a drill-down keeps its granularity: the window shown is the one stepped.
    if (w) setControls({ range: { preset: 'custom', ...w }, granularity: active.granularity });
  };
  const drill = (index: number) => {
    const d = data && drillDown(data.buckets[index], data.granularity);
    if (!d) return;
    setDrillStack((st) => [...st, { granularity: active.granularity, range: active.range }]);
    setZoom({ granularity: d.granularity, range: { preset: 'custom', from: d.from, to: d.to } });
  };
  const drillBack = () => {
    const top = drillStack[drillStack.length - 1];
    if (!top) return;
    setDrillStack(drillStack.slice(0, -1));
    // The bottom of the stack is the stored window itself.
    setZoom(drillStack.length > 1 ? top : null);
  };

  const refresh = () => {
    loader.reset();
    setTick((n) => n + 1);
  };

  const postSync = async (full: boolean) => {
    const res = await fetch(`/api/v1/revenue/sync${full ? '?full=1' : ''}`, { method: 'POST', headers: bearerAuthHeaders() });
    if (!res.ok) throw new Error(failureMessage(res.status, await readJsonBody(res)));
  };
  const rebuild = async () => {
    setRebuildBusy(true);
    try {
      await postSync(true);
      showToast(t('revenue.sync.rebuildStarted'), 'success');
      refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setRebuildBusy(false);
    }
  };
  const retry = async () => {
    try {
      await postSync(false);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), 'error');
    }
    refresh();
  };

  const { itemsPending, ready } = dashboardReady(data);
  const lastBucket = data?.buckets[data.buckets.length - 1];
  const filterParams = filterQuery(basketIds, active.brands, active.kind, active.segment);
  const views = REVENUE_VIEWS.filter((v) => v.id !== 'clients' || can.customers).map((v) => ({ id: v.id, label: t(`revenue.views.${VIEW_KEYS[v.id]}`) }));

  return (
    <div className="space-y-4 p-4 pb-24 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-white">{t('revenue.title')}</h1>
          {data && <RevenueSyncBanner sync={data.sync} canSync={can.sync} busy={rebuildBusy} onRetry={retry} onRebuild={rebuild} />}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <RevenueSegmented
            label={t('revenue.amounts')}
            value={controls.taxMode}
            onChange={(taxMode) => setControls({ taxMode })}
            options={[
              { id: 'ht', label: t('revenue.ht') },
              { id: 'ttc', label: t('revenue.ttc') },
            ]}
          />
          <div data-slot="revenue-menu" />
        </div>
      </div>

      <div data-slot="revenue-controls" className="border-t border-bambu-dark-tertiary pt-5">
        <ControlsRow
          granularity={active.granularity}
          onGranularity={(granularity) => setControls({ granularity })}
          range={active.range}
          onRange={(range) => setControls({ range })}
          from={data?.from ?? ''}
          to={data?.to ?? ''}
          today={today}
          canPrev={windowAt(-1) !== null}
          canNext={windowAt(1) !== null}
          onShift={shift}
          kind={active.kind}
          onKind={(kind) => setControls({ kind })}
          segment={active.segment}
          onSegment={(segment) => setControls({ segment })}
          showSegment={can.customers}
          aside={<RevenueSegmented tabs idPrefix="revenue-view" label={t('revenue.views.label')} value={view} onChange={(v) => setControls({ view: v })} options={views} />}
        >
          <RevenueProductSearch
            products={kindProducts}
            basket={active.basket}
            onAdd={addProducts}
            onRemove={(id) => setControls({ basket: controls.basket.filter((b) => b.itemId !== id) })}
            onClear={() => setControls({ basket: [] })}
            brands={active.brands}
            onToggleBrand={(key) => setControls({ brands: toggleInSet(controls.brands, key) })}
            onClearBrands={() => setControls({ brands: new Set() })}
            extraChips={
              active.kind || active.segment ? (
                <>
                  {active.kind && (
                    <RevenueChip label={t('revenue.filters.type')} value={t(`revenue.filters.${active.kind}`)}
                      removeLabel={t('revenue.filters.removeFilter', { value: t(`revenue.filters.${active.kind}`) })} onRemove={() => setControls({ kind: null })} />
                  )}
                  {active.segment && (
                    <RevenueChip label={t('revenue.filters.customers')} value={t(`revenue.filters.segments.${active.segment}`)}
                      removeLabel={t('revenue.filters.removeFilter', { value: t(`revenue.filters.segments.${active.segment}`) })} onRemove={() => setControls({ segment: null })} />
                  )}
                </>
              ) : null
            }
            // A stored segment this user may not see is not theirs to erase.
            onClearExtra={() => setControls(can.customers ? { kind: null, segment: null } : { kind: null })}
          />
        </ControlsRow>
      </div>

      {error && (
        <div role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}{' '}
          <button type="button" onClick={refresh} className={`ml-2 underline underline-offset-2 ${focusRingCls}`}>
            {t('revenue.sync.retry')}
          </button>
        </div>
      )}

      {!ready ? (
        <Empty>
          {itemsPending ? t('revenue.state.itemsPending') : loading ? t('revenue.state.loading') : t('revenue.state.history')}
          {!loading && <span className="mt-1 block text-xs">{itemsPending ? t('revenue.state.itemsPendingHint') : t('revenue.state.historyHint')}</span>}
        </Empty>
      ) : (
        <section
          role="tabpanel"
          id={segmentPanelId('revenue-view', view)}
          aria-labelledby={segmentTabId('revenue-view', view)}
          data-slot={`revenue-view-${view}`} className="grid gap-3">
          {view === 'evolution' && data && (
            <>
              <RevenueFinding payload={data} taxMode={active.taxMode} />
              <Split>
                <RevenueHero payload={data} taxMode={active.taxMode} canMargin={can.margin} />
                {lastBucket && (
                  <RevenuePace monthKey={(lastBucket.end > today ? today : lastBucket.end).slice(0, 7)} filterParams={filterParams} taxMode={active.taxMode} version={data} />
                )}
              </Split>
              <RevenueChart payload={data} controls={active} can={can} onStack={(stack) => setControls({ stack })}
                onDrill={data.granularity !== 'day' ? drill : undefined} drillDepth={drillStack.length} onBack={drillBack} today={today} />
              <Split>
                <RevenueTable buckets={data.buckets} granularity={data.granularity} taxMode={active.taxMode} canMargin={can.margin} filterParams={filterParams} version={data} />
                <RevenueMovers granularity={data.granularity} bucketKey={lastBucket?.key ?? null} bucketLabel={lastBucket?.label ?? ''} filterParams={filterParams} version={data} today={today} />
              </Split>
            </>
          )}
          {view === 'clients' && can.customers && data && (
            <RevenueCustomers from={data.from} to={data.to} filterParams={filterParams} taxMode={active.taxMode}
              segment={active.segment} onSegment={(segment) => setControls({ segment })} version={data} />
          )}
          {view === 'produits' && data && <RevenueAnalysis from={data.from} to={data.to} filterParams={filterParams} version={data} />}
        </section>
      )}
    </div>
  );
}
