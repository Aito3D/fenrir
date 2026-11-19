import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { bearerAuthHeaders } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { Empty } from '../components/aito/stats/primitives';
import { RevenueSegmented, segmentPanelId, segmentTabId } from '../components/revenue/RevenueSegmented';
import { RevenueSyncBanner } from '../components/revenue/RevenueSyncBanner';
import { focusRingCls } from '../components/formStyles';
import type { StackDimension } from '../components/revenue/lib/chart';
import {
  createSeriesLoader,
  dashboardReady,
  failureMessage,
  pollActive,
  readJsonBody,
  REVENUE_POLL,
  REVENUE_STORAGE_KEYS,
  REVENUE_VIEWS,
  restoreStoredControls,
  seriesQuery,
  startSeriesPoller,
  type RangeChoice,
  type RevenueView,
} from '../components/revenue/lib/dashboard';
import type { CustomerSegment, RevenueGranularity, RevenueKind, RevenueProduct, RevenueResponse, TaxMode } from '../components/revenue/lib/types';

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

const VIEW_KEYS: Record<RevenueView, string> = { evolution: 'evolution', clients: 'clients', produits: 'products', saison: 'seasonality' };

function initialControls(): RevenueControls {
  let stored: ReturnType<typeof restoreStoredControls> = {};
  try {
    stored = restoreStoredControls((k) => localStorage.getItem(k));
  } catch {
    // Storage unavailable (private window): the defaults stand.
  }
  return {
    granularity: stored.granularity ?? 'month',
    taxMode: stored.taxMode ?? 'ht',
    stack: stored.stack ?? 'nature',
    range: stored.preset ? { preset: stored.preset } : { preset: 'default' },
    kind: stored.kind ?? null,
    segment: stored.segment ?? null,
    view: stored.view ?? 'evolution',
    brands: new Set(),
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
  const setControls = (patch: Partial<RevenueControls>) => {
    setControlsState((c) => ({ ...c, ...patch }));
    if (patch.taxMode) persist(REVENUE_STORAGE_KEYS.taxMode, patch.taxMode);
    if (patch.view) persist(REVENUE_STORAGE_KEYS.view, patch.view === 'evolution' ? null : patch.view);
  };
  // What the page may use: a view or segment stored by a user with more rights (shared terminal) falls back.
  const active: RevenueControls = {
    ...controls,
    view: controls.view === 'clients' && !can.customers ? 'evolution' : controls.view,
    segment: can.customers ? controls.segment : null,
  };
  const { view } = active;

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
    basketIds: active.basket.map((b) => b.itemId),
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

      <div className="space-y-4 border-t border-bambu-dark-tertiary pt-5">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div data-slot="revenue-controls" />
          <RevenueSegmented tabs idPrefix="revenue-view" label={t('revenue.views.label')} value={view} onChange={(v) => setControls({ view: v })} options={views} />
        </div>
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
          data-slot={`revenue-view-${view}`} className="grid gap-3" />
      )}
    </div>
  );
}
