import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { SearchableSelect } from '../SearchableSelect';
import { DurationInput } from './DurationInput';
import { Money } from '../calculator/shared';
import { inputCls, labelCls } from '../formStyles';
import { computeImpressionCost } from '../../utils/taskDraft';
import type { ImpressionDraft } from '../../utils/taskDraft';

export interface ImpressionFieldsProps {
  value: ImpressionDraft;
  onChange: (next: ImpressionDraft) => void;
  /** The recomputed total, hoisted so the parent can store it. */
  onCostChange: (total: number | null) => void;
}

/** filament/printer + weight/time/color/quantity for one task's Impression3D
 *  service, plus the live cost breakdown. All arithmetic lives in
 *  `computeImpressionCost` (taskDraft.ts) — this component only collects
 *  inputs and renders the result, the same split the calculator page keeps
 *  between `pricing.ts` and its cards. */
export function ImpressionFields({ value, onChange, onCostChange }: ImpressionFieldsProps) {
  const { t } = useTranslation();
  const reactId = useId();

  const filamentsQuery = useQuery({
    queryKey: ['calculatorFilaments'],
    queryFn: api.getCalculatorFilaments,
    staleTime: 60_000,
  });
  const printersQuery = useQuery({
    queryKey: ['calculatorPrinters'],
    queryFn: api.getCalculatorPrinters,
    staleTime: 60_000,
  });
  const defaultsQuery = useQuery({
    queryKey: ['calculatorDefaults'],
    queryFn: api.getCalculatorDefaults,
    staleTime: 60_000,
  });
  const filaments = filamentsQuery.data ?? [];
  const printers = printersQuery.data ?? [];
  const defaults = defaultsQuery.data;
  const referenceDataLoading = filamentsQuery.isLoading || printersQuery.isLoading || defaultsQuery.isLoading;
  // Same cache key CalculatorPage uses for the app's configured currency, so
  // this and the calculator page share one fetch instead of two.
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.getSettings,
    staleTime: 60_000,
  });
  const currency = settings?.currency || 'USD';

  const filament = filaments.find((f) => f.id === value.filamentId) ?? null;
  const printer = printers.find((p) => p.id === value.printerId) ?? null;

  // CalculatorFilament/CalculatorPrinter are supersets of PricingFilament/
  // PricingPrinter, so they pass straight through — no mapping layer.
  const result = useMemo(
    () => (defaults ? computeImpressionCost(value, filament, printer, defaults) : null),
    [value, filament, printer, defaults],
  );

  // Whether the *user* has changed a print input in this mount. Recomputing
  // and reporting on mount — before any edit — is exactly the bug this guards
  // against: a saved task opens with a frozen `impression_cost`, this effect
  // would otherwise report today's recompute (which may differ, or may be
  // `null` while `defaults` is still resolving, or `null` forever for a
  // dangling printer/filament reference), and the panel would PATCH that over
  // the frozen figure just because the row was looked at. Only a genuine
  // edit — routed through `handleChange` below — may cause a report.
  const [hasEdited, setHasEdited] = useState(false);
  const handleChange = (next: ImpressionDraft) => {
    setHasEdited(true);
    onChange(next);
  };

  // Reporting the total is a side effect on the parent, not something that's
  // safe to do while rendering — it has to happen after commit. Gated on
  // `hasEdited` (see above) and held back until printer/filament/defaults
  // have all resolved, so a still-loading `defaults` query can't momentarily
  // report `null` and clobber a stored cost mid-fetch.
  useEffect(() => {
    if (!hasEdited || referenceDataLoading) return;
    onCostChange(result?.total_ttc_qty ?? null);
  }, [result, onCostChange, hasEdited, referenceDataLoading]);

  if (printers.length === 0) {
    return (
      <p className="text-sm text-bambu-gray">
        {t('aito.noPrintersConfigured')}{' '}
        <Link to="/calculator" className="text-bambu-green hover:underline">
          {t('calculator.title')}
        </Link>
      </p>
    );
  }
  if (filaments.length === 0) {
    return (
      <p className="text-sm text-bambu-gray">
        {t('aito.noFilamentsConfigured')}{' '}
        <Link to="/calculator" className="text-bambu-green hover:underline">
          {t('calculator.title')}
        </Link>
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 lg:gap-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor={`${reactId}-printer`} className={labelCls}>
            {t('aito.printer')}
          </label>
          <SearchableSelect
            id={`${reactId}-printer`}
            value={value.printerId === null ? '' : String(value.printerId)}
            onChange={(v) => handleChange({ ...value, printerId: v === '' ? null : Number(v) })}
            options={printers.map((p) => ({ value: String(p.id), label: p.name }))}
            allowCustom={false}
          />
        </div>
        <div>
          <label htmlFor={`${reactId}-material`} className={labelCls}>
            {t('aito.material')}
          </label>
          <SearchableSelect
            id={`${reactId}-material`}
            value={value.filamentId === null ? '' : String(value.filamentId)}
            onChange={(v) => handleChange({ ...value, filamentId: v === '' ? null : Number(v) })}
            options={filaments.map((f) => ({ value: String(f.id), label: f.name }))}
            allowCustom={false}
          />
        </div>
        <div>
          <label htmlFor={`${reactId}-weight`} className={labelCls}>
            {t('aito.weightG')}
          </label>
          <input
            id={`${reactId}-weight`}
            type="number"
            min={0}
            inputMode="decimal"
            value={value.weightG ?? ''}
            onChange={(e) =>
              handleChange({
                ...value,
                weightG: e.target.value === '' ? null : Math.max(0, Number(e.target.value)),
              })
            }
            className={inputCls}
          />
        </div>
        <div>
          <label htmlFor={`${reactId}-time`} className={labelCls}>
            {t('aito.printTime')}
          </label>
          <DurationInput
            id={`${reactId}-time`}
            minutes={value.timeMin}
            onChange={(timeMin) => handleChange({ ...value, timeMin })}
          />
        </div>
        <div>
          <label htmlFor={`${reactId}-color`} className={labelCls}>
            {t('aito.color')}
          </label>
          <input
            id={`${reactId}-color`}
            type="text"
            value={value.color}
            onChange={(e) => handleChange({ ...value, color: e.target.value })}
            className={inputCls}
          />
        </div>
        <div>
          <label htmlFor={`${reactId}-quantity`} className={labelCls}>
            {t('aito.quantity')}
          </label>
          <input
            id={`${reactId}-quantity`}
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={value.quantity}
            onChange={(e) =>
              handleChange({
                ...value,
                quantity: e.target.value === '' ? 1 : Math.max(1, Math.floor(Number(e.target.value) || 1)),
              })
            }
            className={inputCls}
          />
        </div>
      </div>
      {result && (
        <div className="space-y-1 pt-2 border-t border-bambu-dark-tertiary lg:border-t-0 lg:pt-0 lg:border-l lg:border-bambu-dark-tertiary lg:pl-4">
          {(
            [
              ['calculator.costFilament', result.filament_cost],
              ['calculator.costDepreciation', result.depreciation_cost],
              ['calculator.costEnergy', result.energy_cost],
              ['calculator.costRepairs', result.repairs_cost],
              ['calculator.groupProvisions', result.prototype_cost + result.failures_cost],
              ['calculator.costAds', result.ads_cost],
              ['calculator.marge', result.marge],
            ] as const
          ).map(([labelKey, lineValue]) => (
            <div key={labelKey} className="flex justify-between gap-2 text-sm">
              <span className="text-bambu-gray-light">{t(labelKey)}</span>
              <Money currency={currency} value={lineValue} className="text-white" />
            </div>
          ))}
          <div className="flex justify-between gap-2 text-sm font-medium pt-1">
            <span className="text-white">{t('calculator.totalTTC')}</span>
            <Money currency={currency} value={result.total_ttc} className="text-bambu-green" />
          </div>
          {value.quantity > 1 && (
            <div className="flex justify-between gap-2 text-sm font-medium">
              <span className="text-white">{t('calculator.forQuantity', { count: value.quantity })}</span>
              <Money currency={currency} value={result.total_ttc_qty} className="text-bambu-green" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
