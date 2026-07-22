import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Calculator as CalculatorIcon, RotateCcw } from 'lucide-react';
import { api } from '../api/client';
import { Card, CardContent } from '../components/Card';
import { focusRingCls } from '../components/formStyles';
import { Button } from '../components/Button';
import { Toggle } from '../components/Toggle';
import { ConfirmModal } from '../components/ConfirmModal';
import {
  CalculatorDefaultsPanel,
  CalculatorFilamentsPanel,
  CalculatorPrintersPanel,
} from '../components/CalculatorSettingsPanels';
import { CalculatorInputsCard } from '../components/calculator/CalculatorInputsCard';
import { CalculatorLaborCard } from '../components/calculator/CalculatorLaborCard';
import { CalculatorRealityCheckCard } from '../components/calculator/CalculatorRealityCheckCard';
import { CalculatorTotalsCard } from '../components/calculator/CalculatorTotalsCard';
import { CalculatorBreakdownCard } from '../components/calculator/CalculatorBreakdownCard';
import { CalculatorDiscountTable } from '../components/calculator/CalculatorDiscountTable';
import { CalculatorBulkTable } from '../components/calculator/CalculatorBulkTable';
import { CalculatorMobileSummary } from '../components/calculator/CalculatorMobileSummary';
import type { Segment } from '../components/calculator/shared';
import { buildPricingInputs, foldSessionOverrides, PAGE_TABS, persistCalculatorStateNow, useCalculatorState, type PageTab } from '../hooks/useCalculatorState';
import {
  bulkPricing,
  computePricing,
  type PricingInputs,
  type PricingResult,
} from '../utils/pricing';
import { getCurrencySymbol } from '../utils/currency';
import {
  checkKey,
  hasRealityCheckData,
  pickTimeAccuracy,
  realityCheckImpact,
  selectRealityChecks,
  type RealityCheck,
  type RealityCheckKind,
} from '../utils/calculatorInsights';
import { buildQuoteSummary } from '../utils/quoteSummary';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';

const TAB_LABEL_KEYS: Record<PageTab, string> = {
  calculator: 'calculator.title',
  filaments: 'calculator.tabFilaments',
  printers: 'calculator.tabPrinters',
  defaults: 'calculator.tabDefaults',
};

export function CalculatorPage() {
  const { t } = useTranslation();
  const { state, set, reset, errors, tab, setTab } = useCalculatorState();
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const navigate = useNavigate();

  const { data: filaments = [], isLoading: filamentsLoading } = useQuery({
    queryKey: ['calculatorFilaments'],
    queryFn: api.getCalculatorFilaments,
    staleTime: 60_000,
  });
  const { data: printers = [], isLoading: printersLoading } = useQuery({
    queryKey: ['calculatorPrinters'],
    queryFn: api.getCalculatorPrinters,
    staleTime: 60_000,
  });
  const { data: defaults, isLoading: defaultsLoading } = useQuery({
    queryKey: ['calculatorDefaults'],
    queryFn: api.getCalculatorDefaults,
    staleTime: 60_000,
  });
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.getSettings,
  });
  // Measured reality-check figures. Failure-tolerant on purpose: when the
  // endpoint is unavailable the card simply doesn't render.
  const { data: insights } = useQuery({
    queryKey: ['calculatorInsights'],
    queryFn: () => api.getCalculatorInsights(),
    staleTime: 300_000,
    retry: false,
  });
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const currency = settings?.currency || 'USD';
  const currencySymbol = getCurrencySymbol(currency);

  // Keep the persisted selection honest: when the saved profile was deleted
  // (or nothing is selected yet), fall back to the first profile IN STATE so
  // what is displayed, persisted and delete-guarded is the same thing.
  useEffect(() => {
    if (filaments.length === 0) return;
    if (state.filamentId === null || !filaments.some((f) => f.id === state.filamentId)) {
      set({ filamentId: filaments[0].id });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filaments, state.filamentId]);
  useEffect(() => {
    if (printers.length === 0) return;
    if (state.printerId === null || !printers.some((p) => p.id === state.printerId)) {
      set({ printerId: printers[0].id });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printers, state.printerId]);

  const filament = filaments.find((f) => f.id === state.filamentId) ?? filaments[0];
  const printer = printers.find((p) => p.id === state.printerId) ?? printers[0];

  const inputs: PricingInputs | null = useMemo(() => {
    if (!defaults) return null;
    return buildPricingInputs(state, defaults);
  }, [state, defaults]);

  // Inputs/printer/defaults with the reality-check session overrides folded
  // in. The pricing engine is untouched — an applied measured value is just a
  // different input.
  const effective = useMemo(() => {
    if (!inputs || !defaults || !printer) return null;
    return foldSessionOverrides(state, defaults, printer, inputs);
  }, [inputs, defaults, printer, state]);

  const result: PricingResult | null = useMemo(() => {
    if (!effective || !filament) return null;
    return computePricing(effective.inputs, filament, effective.printer, effective.defaults);
  }, [effective, filament]);

  // Per-printer totals for the comparison chips above the total price — the
  // same inputs priced against every configured printer, so the operator can
  // see at a glance which machine is cheaper for this job. The printer-scoped
  // overrides (power, daily hours) were measured for the SELECTED machine
  // only, so every other row prices against its stored profile.
  const printerComparison = useMemo(() => {
    if (!effective || !filament || printers.length < 2) return [];
    return printers.map((p) => ({
      id: p.id,
      name: p.name,
      total: computePricing(
        effective.inputs,
        filament,
        p.id === printer?.id ? effective.printer : p,
        effective.defaults,
      ).total_ttc,
    }));
  }, [effective, filament, printers, printer?.id]);

  const segments: Segment[] = useMemo(() => {
    if (!result) return [];
    return [
      { key: 'filament', label: t('calculator.costFilament'), value: result.filament_cost, color: 'var(--viz-1)' },
      { key: 'printer', label: t('calculator.splitPrinter'), value: result.depreciation_cost + result.repairs_cost, color: 'var(--viz-2)' },
      { key: 'energy', label: t('calculator.costEnergy'), value: result.energy_cost, color: 'var(--viz-3)' },
      { key: 'provisions', label: t('calculator.groupProvisions'), value: result.prototype_cost + result.failures_cost, color: 'var(--viz-4)' },
      { key: 'other', label: t('calculator.splitAdsConsumables'), value: result.ads_cost + result.consumables_flat + result.base_fee, color: 'var(--viz-5)' },
      { key: 'labor', label: t('calculator.groupLabor'), value: result.labor_total, color: 'var(--viz-6)' },
    ].filter((s) => s.value > 0.005);
  }, [result, t]);

  const bulk = useMemo(() => {
    if (!effective || !filament) return [];
    return bulkPricing(effective.inputs, filament, effective.printer, effective.defaults);
  }, [effective, filament]);

  // All disagreement rows, before dismissal filtering — needed to tell
  // "everything agrees" (all-clear) apart from "everything was dismissed".
  const allRealityChecks = useMemo(
    () =>
      selectRealityChecks(
        insights,
        filament,
        printer,
        defaults,
        {
          failureRateOverride: state.failureRateOverride,
          tariffOverride: state.tariffOverride,
          timeAccuracyOverride: state.timeAccuracyOverride,
          powerWattsOverride: state.powerWattsOverride,
          dailyHoursOverride: state.dailyHoursOverride,
        },
        inputs ? { fromEstimate: state.timeFromEstimate, estimateH: inputs.printing_time_h } : undefined,
      ),
    [
      insights,
      filament,
      printer,
      defaults,
      inputs,
      state.failureRateOverride,
      state.tariffOverride,
      state.timeAccuracyOverride,
      state.powerWattsOverride,
      state.dailyHoursOverride,
      state.timeFromEstimate,
    ],
  );
  const realityChecks = useMemo(
    () => allRealityChecks.filter((c) => !state.dismissedChecks.includes(checkKey(c))),
    [allRealityChecks, state.dismissedChecks],
  );
  // Per-unit price delta of applying each visible check, against the RAW
  // (un-overridden) inputs — "what would this do to the quote".
  const impacts = useMemo(() => {
    if (!inputs || !filament || !printer || !defaults) return {};
    return Object.fromEntries(
      realityChecks.map((c) => [checkKey(c), realityCheckImpact(c, inputs, filament, printer, defaults)]),
    );
  }, [realityChecks, inputs, filament, printer, defaults]);
  const timeAccuracy = useMemo(() => pickTimeAccuracy(insights, printer), [insights, printer]);

  // The printer-scoped overrides were measured for one machine — they must
  // not leak onto another profile when the selection changes.
  const prevPrinterId = useRef(state.printerId);
  useEffect(() => {
    if (prevPrinterId.current !== null && state.printerId !== prevPrinterId.current) {
      set({ powerWattsOverride: '', dailyHoursOverride: '', timeAccuracyOverride: '' });
    }
    prevPrinterId.current = state.printerId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.printerId]);

  const saveDefaultMutation = useMutation({
    mutationFn: (patch: { failure_rate_pct?: number; electricity_tariff?: number }) =>
      api.updateCalculatorDefaults(patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calculatorDefaults'] });
      showToast(t('calculator.realityCheck.savedDefault'));
    },
  });
  const updateFilamentCostMutation = useMutation({
    mutationFn: ({ id, cost }: { id: number; cost: number }) => api.updateCalculatorFilament(id, { cost_per_kg: cost }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calculatorFilaments'] });
      showToast(t('calculator.realityCheck.profileUpdated'));
    },
  });
  const updatePrinterProfileMutation = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: { power_watts?: number; daily_usage_hours?: number } }) =>
      api.updateCalculatorPrinter(id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calculatorPrinters'] });
      showToast(t('calculator.realityCheck.printerUpdated'));
    },
  });

  // Session-override field for each overridable check kind, and the value the
  // override stores. The time row stores the measured accuracy %, not the
  // corrected hours, so the correction keeps tracking edits to the estimate.
  const overrideFieldFor: Record<Exclude<RealityCheckKind, 'spoolCost'>, 'failureRateOverride' | 'tariffOverride' | 'timeAccuracyOverride' | 'powerWattsOverride' | 'dailyHoursOverride'> = {
    failure: 'failureRateOverride',
    tariff: 'tariffOverride',
    time: 'timeAccuracyOverride',
    power: 'powerWattsOverride',
    dailyHours: 'dailyHoursOverride',
  };
  const overrideValueFor = (check: RealityCheck): string =>
    check.kind === 'time' ? String((check.assumed / check.measured) * 100) : String(check.measured);
  const applyChecks = (checks: RealityCheck[]) =>
    set(
      Object.fromEntries(
        checks
          .filter((c) => c.kind !== 'spoolCost')
          .map((c) => [overrideFieldFor[c.kind as Exclude<RealityCheckKind, 'spoolCost'>], overrideValueFor(c)]),
      ),
    );

  // Plain-text job spec for the copy button on the totals card.
  const summaryText = useMemo(() => {
    if (!filament || !printer) return '';
    return buildQuoteSummary(filament, printer, state);
  }, [filament, printer, state]);

  const isLoading = filamentsLoading || printersLoading || defaultsLoading;
  const isEmpty = !isLoading && (filaments.length === 0 || printers.length === 0);
  const hasErrors = Object.keys(errors).length > 0;
  const easy = state.easyMode;
  // Without weight AND time the "price" would just be the flat consumables
  // constant marked up — show a hint instead of a misleading quote.
  const noPrintData = !!inputs && inputs.weight_g <= 0 && inputs.printing_time_h <= 0;

  const tabRefs = useRef<Partial<Record<PageTab, HTMLButtonElement | null>>>({});
  const [tabIndicator, setTabIndicator] = useState({ left: 0, width: 0 });
  useLayoutEffect(() => {
    const el = tabRefs.current[tab];
    if (el) setTabIndicator({ left: el.offsetLeft, width: el.offsetWidth });
  }, [tab]);

  const onTablistKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const idx = PAGE_TABS.indexOf(tab);
    const offset = e.key === 'ArrowRight' ? 1 : PAGE_TABS.length - 1;
    const next = PAGE_TABS[(idx + offset) % PAGE_TABS.length];
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="p-4 md:p-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-3">
            <CalculatorIcon className="w-7 h-7 text-bambu-green" />
            {t('calculator.title')}
          </h1>
          <p className="text-bambu-gray mt-1">{t('calculator.subtitle')}</p>
        </div>
        {tab === 'calculator' && (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 text-sm text-bambu-gray-light select-none">
              <Toggle
                checked={state.easyMode}
                onChange={(v) => set({ easyMode: v })}
                aria-label={t('calculator.easyMode')}
              />
              <button type="button" className={`cursor-pointer rounded ${focusRingCls}`} onClick={() => set({ easyMode: !state.easyMode })}>
                {t('calculator.easyMode')}
              </button>
            </div>
            <Button variant="secondary" size="sm" className="group" onClick={() => setShowResetConfirm(true)}>
              <RotateCcw className="w-4 h-4 transition-transform duration-200 ease-out group-hover:-rotate-180 motion-reduce:transition-none" />
              {t('calculator.reset')}
            </Button>
          </div>
        )}
      </div>

      <div
        role="tablist"
        aria-label={t('calculator.title')}
        onKeyDown={onTablistKeyDown}
        className="relative flex gap-1 border-b border-bambu-dark-tertiary mb-6"
      >
        {PAGE_TABS.map((id) => (
          <button
            key={id}
            id={`calc-tab-${id}`}
            role="tab"
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            ref={(el) => {
              tabRefs.current[id] = el;
            }}
            onClick={() => setTab(id)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-[color,transform] duration-100 ease-out motion-safe:active:scale-95 ${focusRingCls} ${
              tab === id ? 'text-bambu-green' : 'text-bambu-gray hover:text-white'
            }`}
          >
            {t(TAB_LABEL_KEYS[id])}
          </button>
        ))}
        <span
          aria-hidden="true"
          className="absolute bottom-0 h-0.5 bg-bambu-green transition-[left,width] duration-[250ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
          style={{ left: tabIndicator.left, width: tabIndicator.width }}
        />
      </div>

      {tab === 'filaments' && (
        <div key="filaments" role="tabpanel" aria-labelledby="calc-tab-filaments" className="animate-calc-tab-in">
          <CalculatorFilamentsPanel selectedFilamentId={filament?.id ?? null} />
        </div>
      )}
      {tab === 'printers' && (
        <div key="printers" role="tabpanel" aria-labelledby="calc-tab-printers" className="animate-calc-tab-in">
          <CalculatorPrintersPanel selectedPrinterId={printer?.id ?? null} />
        </div>
      )}
      {tab === 'defaults' && (
        <div key="defaults" role="tabpanel" aria-labelledby="calc-tab-defaults" className="animate-calc-tab-in">
          <CalculatorDefaultsPanel />
        </div>
      )}

      {tab === 'calculator' && (
        <div role="tabpanel" aria-labelledby="calc-tab-calculator">
          {isLoading && (
            <div className="grid grid-cols-1 xl:grid-cols-[minmax(320px,400px)_1fr] gap-6 items-start" aria-hidden="true">
              <div className="space-y-6">
                <div className="h-64 rounded-xl bg-bambu-dark-secondary border border-bambu-dark-tertiary animate-pulse motion-reduce:animate-none" />
                <div className="h-80 rounded-xl bg-bambu-dark-secondary border border-bambu-dark-tertiary animate-pulse motion-reduce:animate-none" />
              </div>
              <div className="space-y-6">
                <div className="h-48 rounded-xl bg-bambu-dark-secondary border border-bambu-dark-tertiary animate-pulse motion-reduce:animate-none" />
                <div className="h-64 rounded-xl bg-bambu-dark-secondary border border-bambu-dark-tertiary animate-pulse motion-reduce:animate-none" />
                <div className="h-56 rounded-xl bg-bambu-dark-secondary border border-bambu-dark-tertiary animate-pulse motion-reduce:animate-none" />
              </div>
            </div>
          )}

          {isEmpty && (
            <Card className="max-w-lg mx-auto animate-calc-rise">
              <CardContent className="text-center space-y-4">
                <div className="w-14 h-14 rounded-full bg-bambu-green/10 flex items-center justify-center mx-auto">
                  <CalculatorIcon className="w-7 h-7 text-bambu-green" />
                </div>
                <h2 className="text-lg font-semibold text-white">{t('calculator.emptyTitle')}</h2>
                <p className="text-bambu-gray">{t('calculator.emptyMessage')}</p>
                <Button onClick={() => setTab(filaments.length === 0 ? 'filaments' : 'printers')}>
                  {t('calculator.openSettings')}
                </Button>
              </CardContent>
            </Card>
          )}

          {!isLoading && !isEmpty && result && defaults && (
            <>
              <div className="grid grid-cols-1 xl:grid-cols-[minmax(320px,400px)_1fr] gap-6 items-start">
                {/* Left column — inputs */}
                <div className="space-y-6 xl:sticky xl:top-8">
                  <CalculatorInputsCard
                    state={state}
                    errors={errors}
                    set={set}
                    filaments={filaments}
                    printers={printers}
                    filament={filament}
                    printer={printer}
                    timeAccuracy={timeAccuracy}
                    showTimeChip={easy}
                  />
                  {!easy && (
                    <CalculatorRealityCheckCard
                      checks={realityChecks}
                      impacts={impacts}
                      currency={currency}
                      windowDays={insights?.window_days}
                      applied={{
                        failure: state.failureRateOverride !== '',
                        tariff: state.tariffOverride !== '',
                        time: state.timeAccuracyOverride !== '',
                        power: state.powerWattsOverride !== '',
                        dailyHours: state.dailyHoursOverride !== '',
                      }}
                      onApply={(check) => applyChecks([check])}
                      onApplyAll={applyChecks}
                      onRevert={(kind) => {
                        if (kind !== 'spoolCost') set({ [overrideFieldFor[kind]]: '' });
                      }}
                      onSaveDefault={(kind, value) => {
                        saveDefaultMutation.mutate(
                          kind === 'failure' ? { failure_rate_pct: value } : { electricity_tariff: value },
                        );
                        // The saved default now equals the measured value —
                        // the session override would just shadow it.
                        set(kind === 'failure' ? { failureRateOverride: '' } : { tariffOverride: '' });
                      }}
                      onUpdateFilamentCost={(id, cost) => updateFilamentCostMutation.mutate({ id, cost })}
                      onUpdatePrinterProfile={(id, patch) => {
                        updatePrinterProfileMutation.mutate({ id, patch });
                        // The profile now holds the measured figure — the
                        // session override would just shadow it.
                        set(patch.power_watts !== undefined ? { powerWattsOverride: '' } : { dailyHoursOverride: '' });
                      }}
                      onDismiss={(key) => set({ dismissedChecks: [...state.dismissedChecks, key] })}
                      dismissedCount={state.dismissedChecks.length}
                      onRestoreDismissed={() => set({ dismissedChecks: [] })}
                      canUpdate={hasPermission('calculator:update')}
                      allClear={allRealityChecks.length === 0 && hasRealityCheckData(insights)}
                    />
                  )}
                  <CalculatorLaborCard
                    state={state}
                    errors={errors}
                    set={set}
                    result={result}
                    defaults={defaults}
                    currency={currency}
                    currencySymbol={currencySymbol}
                  />
                </div>

                {/* Right column — results */}
                <div className="space-y-4">
                  {hasErrors && (
                    <div
                      role="alert"
                      className="rounded-lg border border-status-error/40 bg-status-error/10 px-4 py-2.5 text-sm text-status-error"
                    >
                      {t('calculator.fixErrors')}
                    </div>
                  )}
                  {noPrintData ? (
                    <Card className="animate-calc-rise">
                      <CardContent className="text-center space-y-3 py-10">
                        <div className="w-14 h-14 rounded-full bg-bambu-green/10 flex items-center justify-center mx-auto">
                          <CalculatorIcon className="w-7 h-7 text-bambu-green" />
                        </div>
                        <h2 className="text-lg font-semibold text-white">{t('calculator.emptyInputsTitle')}</h2>
                        <p className="text-bambu-gray">{t('calculator.emptyInputsMessage')}</p>
                      </CardContent>
                    </Card>
                  ) : (
                    <div className={`space-y-6 transition-opacity ${hasErrors ? 'opacity-60' : ''}`}>
                      <CalculatorTotalsCard
                        result={result}
                        segments={segments}
                        currency={currency}
                        easy={easy}
                        summaryText={summaryText}
                        taxPct={defaults.tax_pct}
                        targetPrice={state.targetPrice}
                        onTargetPriceChange={(v) => set({ targetPrice: v })}
                        targetPriceError={errors.targetPrice}
                        printerComparison={printerComparison}
                        selectedPrinterId={printer?.id ?? null}
                        onSelectPrinter={(id) => set({ printerId: id })}
                        onOpenQuote={() => {
                          // The quote page re-reads localStorage; flush the
                          // debounced persist so it can't be 500ms stale.
                          persistCalculatorStateNow(state);
                          navigate('/calculator/quote');
                        }}
                      />
                      {!easy && <CalculatorBreakdownCard result={result} currency={currency} />}
                      <CalculatorDiscountTable result={result} currency={currency} easy={easy} />
                      {!easy && <CalculatorBulkTable rows={bulk} currency={currency} />}
                    </div>
                  )}
                </div>
              </div>
              {!noPrintData && <CalculatorMobileSummary result={result} currency={currency} />}
            </>
          )}
        </div>
      )}

      {showResetConfirm && (
        <ConfirmModal
          title={t('calculator.resetConfirmTitle')}
          message={t('calculator.resetConfirmMessage')}
          variant="warning"
          onConfirm={() => {
            reset();
            setShowResetConfirm(false);
          }}
          onCancel={() => setShowResetConfirm(false)}
        />
      )}
    </div>
  );
}
