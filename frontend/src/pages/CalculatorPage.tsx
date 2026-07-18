import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Calculator as CalculatorIcon, RotateCcw } from 'lucide-react';
import { api } from '../api/client';
import { Card, CardContent } from '../components/Card';
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
import { CalculatorTotalsCard } from '../components/calculator/CalculatorTotalsCard';
import { CalculatorBreakdownCard } from '../components/calculator/CalculatorBreakdownCard';
import { CalculatorDiscountTable } from '../components/calculator/CalculatorDiscountTable';
import { CalculatorBulkTable } from '../components/calculator/CalculatorBulkTable';
import { CalculatorMobileSummary } from '../components/calculator/CalculatorMobileSummary';
import type { Segment } from '../components/calculator/shared';
import { num, PAGE_TABS, useCalculatorState, type PageTab } from '../hooks/useCalculatorState';
import {
  bulkPricing,
  computePricing,
  formatMoney,
  formatPct,
  type PricingInputs,
  type PricingResult,
} from '../utils/pricing';
import { getCurrencySymbol } from '../utils/currency';

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
    return {
      weight_g: Math.max(0, num(state.weight)),
      printing_time_h: Math.max(0, num(state.timeH)) + Math.max(0, num(state.timeM)) / 60,
      measured_energy_kwh: num(state.energyKwh) > 0 ? num(state.energyKwh) : undefined,
      quantity: Math.max(1, Math.floor(num(state.quantity, 1))),
      modeling_hours: Math.max(0, num(state.modelingHours)),
      modeling_base_price: Math.max(0, num(state.modelingBasePrice)),
      prep_model_min: Math.max(0, num(state.prepModel)),
      prep_slicing_min: Math.max(0, num(state.prepSlicing)),
      prep_transfer_min: Math.max(0, num(state.prepTransfer)),
      post_removal_min: Math.max(0, num(state.postRemoval)),
      post_support_min: Math.max(0, num(state.postSupport)),
      post_additional_min: Math.max(0, num(state.postAdditional)),
      post_fulfillment_min: Math.max(0, num(state.postFulfillment)),
      stuff_amount: Math.max(0, num(state.stuffAmount)),
      stuff_markup_pct: Math.max(0, num(state.stuffMarkup, defaults.stuff_markup_pct)),
    };
  }, [state, defaults]);

  const result: PricingResult | null = useMemo(() => {
    if (!inputs || !filament || !printer || !defaults) return null;
    return computePricing(inputs, filament, printer, defaults);
  }, [inputs, filament, printer, defaults]);

  // Per-printer totals for the comparison chips above the total price — the
  // same inputs priced against every configured printer, so the operator can
  // see at a glance which machine is cheaper for this job.
  const printerComparison = useMemo(() => {
    if (!inputs || !filament || !defaults || printers.length < 2) return [];
    return printers.map((p) => ({
      id: p.id,
      name: p.name,
      total: computePricing(inputs, filament, p, defaults).total_ttc,
    }));
  }, [inputs, filament, printers, defaults]);

  const segments: Segment[] = useMemo(() => {
    if (!result) return [];
    return [
      { key: 'filament', label: t('calculator.costFilament'), value: result.filament_cost, color: 'var(--viz-1)' },
      { key: 'printer', label: t('calculator.splitPrinter'), value: result.depreciation_cost + result.repairs_cost, color: 'var(--viz-2)' },
      { key: 'energy', label: t('calculator.costEnergy'), value: result.energy_cost, color: 'var(--viz-3)' },
      { key: 'provisions', label: t('calculator.groupProvisions'), value: result.prototype_cost + result.failures_cost, color: 'var(--viz-4)' },
      { key: 'other', label: t('calculator.splitAdsConsumables'), value: result.ads_cost + result.consumables_flat, color: 'var(--viz-5)' },
      { key: 'labor', label: t('calculator.groupLabor'), value: result.labor_total, color: 'var(--viz-6)' },
    ].filter((s) => s.value > 0.005);
  }, [result, t]);

  const bulk = useMemo(() => {
    if (!inputs || !filament || !printer || !defaults) return [];
    return bulkPricing(inputs, filament, printer, defaults);
  }, [inputs, filament, printer, defaults]);

  // Plain-text quote summary for the copy button on the totals card.
  const summaryText = useMemo(() => {
    if (!result || !filament || !printer) return '';
    const time = `${Math.max(0, num(state.timeH))}h${state.timeM.trim() ? ` ${state.timeM}min` : ''}`;
    const lines = [
      `${t('calculator.title')} — ${filament.name} · ${printer.name}`,
      `${t('calculator.weight')}: ${state.weight || '0'} · ${t('calculator.printingTime')}: ${time} · ${t('calculator.quantity')}: ${result.quantity}`,
      `${t('calculator.machineCost')}: ${formatMoney(result.machine_cost, currency)}`,
      `${t('calculator.groupLabor')}: ${formatMoney(result.labor_total, currency)}`,
      `${t('calculator.totalHT')}: ${formatMoney(result.total_ht, currency)}`,
      `${t('calculator.totalTTC')}: ${formatMoney(result.total_ttc, currency)}`,
    ];
    if (result.quantity > 1) {
      lines.push(`${t('calculator.forQuantity', { count: result.quantity })}: ${formatMoney(result.total_ttc_qty, currency)}`);
    }
    lines.push(`${t('calculator.marginPct')}: ${formatPct(result.margin_pct)}`);
    return lines.join('\n');
  }, [result, filament, printer, state, currency, t]);

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
              <button type="button" className="cursor-pointer" onClick={() => set({ easyMode: !state.easyMode })}>
                {t('calculator.easyMode')}
              </button>
            </div>
            <Button variant="secondary" size="sm" onClick={() => setShowResetConfirm(true)}>
              <RotateCcw className="w-4 h-4" />
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
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              tab === id ? 'text-bambu-green' : 'text-bambu-gray hover:text-white'
            }`}
          >
            {t(TAB_LABEL_KEYS[id])}
          </button>
        ))}
        <span
          aria-hidden="true"
          className="absolute bottom-0 h-0.5 bg-bambu-green transition-[left,width] duration-200 ease-out"
          style={{ left: tabIndicator.left, width: tabIndicator.width }}
        />
      </div>

      {tab === 'filaments' && (
        <div role="tabpanel" aria-labelledby="calc-tab-filaments">
          <CalculatorFilamentsPanel selectedFilamentId={filament?.id ?? null} />
        </div>
      )}
      {tab === 'printers' && (
        <div role="tabpanel" aria-labelledby="calc-tab-printers">
          <CalculatorPrintersPanel selectedPrinterId={printer?.id ?? null} />
        </div>
      )}
      {tab === 'defaults' && (
        <div role="tabpanel" aria-labelledby="calc-tab-defaults">
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
                  />
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
                      />
                      {!easy && <CalculatorBreakdownCard result={result} segments={segments} currency={currency} />}
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
