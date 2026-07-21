import { useTranslation } from 'react-i18next';
import { Info, Minus, Package, Plus, Timer, X, Zap } from 'lucide-react';
import type { CalculatorFilament, CalculatorPrinter } from '../../api/client';
import { Card, CardContent, CardHeader } from '../Card';
import { NumberField } from '../NumberField';
import { SearchableSelect } from '../SearchableSelect';
import { Tooltip } from '../Tooltip';
import { labelCls } from '../formStyles';
import { formatPct } from '../../utils/pricing';
import { correctedTimeH } from '../../utils/calculatorInsights';
import { num, splitDecimalHours, type CalcState } from '../../hooks/useCalculatorState';

function QuantityField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  const { t } = useTranslation();
  const step = (delta: number) => {
    const current = Math.max(1, Math.floor(num(value, 1)));
    onChange(String(Math.max(1, current + delta)));
  };
  return (
    <div>
      <label htmlFor="calc-quantity" className={labelCls}>
        {t('calculator.quantity')}
      </label>
      <div
        className={`flex items-stretch rounded-lg border bg-bambu-dark transition-colors focus-within:ring-2 ${
          error
            ? 'border-status-error/70 focus-within:border-status-error focus-within:ring-status-error/20'
            : 'border-bambu-dark-tertiary focus-within:border-bambu-green focus-within:ring-bambu-green/20'
        }`}
      >
        <button
          type="button"
          aria-label={t('calculator.qtyDecrease')}
          onClick={() => step(-1)}
          disabled={Math.floor(num(value, 1)) <= 1}
          className="px-2.5 text-bambu-gray hover:text-white disabled:opacity-40 disabled:hover:text-bambu-gray transition-[color,transform] duration-100 ease-out motion-safe:active:scale-90"
        >
          <Minus className="w-4 h-4" />
        </button>
        <input
          id="calc-quantity"
          type="number"
          inputMode="numeric"
          autoComplete="off"
          min="1"
          step="1"
          className="w-full min-w-0 px-1 py-2 bg-transparent text-center text-white no-spinner focus:outline-none"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={!!error}
        />
        <button
          type="button"
          aria-label={t('calculator.qtyIncrease')}
          onClick={() => step(1)}
          className="px-2.5 text-bambu-gray hover:text-white transition-[color,transform] duration-100 ease-out motion-safe:active:scale-90"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
      {error && <p className="text-xs text-status-error mt-1">{error}</p>}
    </div>
  );
}

export function CalculatorInputsCard({
  state,
  errors,
  set,
  filaments,
  printers,
  filament,
  printer,
  timeAccuracy,
  showTimeChip,
}: {
  state: CalcState;
  errors: Partial<Record<keyof CalcState, string>>;
  set: (patch: Partial<CalcState>) => void;
  filaments: CalculatorFilament[];
  printers: CalculatorPrinter[];
  filament?: CalculatorFilament;
  printer?: CalculatorPrinter;
  timeAccuracy?: { accuracy_pct: number; sample: number; scope: string | null } | null;
  /** Easy mode shows the correction as this inline chip; advanced mode has
      the reality-check card's time row instead. */
  showTimeChip?: boolean;
}) {
  const { t } = useTranslation();
  // Offer the time correction only while the time still comes from a slicer
  // estimate and the measured drift is worth correcting (≥2%).
  const showTimeCorrection =
    showTimeChip && state.timeFromEstimate && timeAccuracy != null && Math.abs(timeAccuracy.accuracy_pct - 100) >= 2;
  const applyTimeCorrection = () => {
    if (!timeAccuracy) return;
    const estimateH = num(state.timeH) + num(state.timeM) / 60;
    set({
      ...splitDecimalHours(correctedTimeH(estimateH, timeAccuracy.accuracy_pct)),
      timeFromEstimate: false,
      // The correction is baked into the fields now — a lingering session
      // override from the reality-check card would correct it twice.
      timeAccuracyOverride: '',
    });
  };
  return (
    <Card className="animate-calc-rise">
      <CardHeader>
        <h2 className="font-semibold text-white flex items-center gap-2">
          <Package className="w-4 h-4 text-bambu-gray" />
          {t('calculator.informations')}
        </h2>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            id="calc-weight"
            label={t('calculator.weight')}
            value={state.weight}
            onChange={(v) => set({ weight: v })}
            error={errors.weight}
            placeholder="0"
          />
          <QuantityField value={state.quantity} onChange={(v) => set({ quantity: v })} error={errors.quantity} />
          <NumberField
            id="calc-time-h"
            label={t('calculator.printingTime')}
            value={state.timeH}
            onChange={(v) => set({ timeH: v, timeFromEstimate: false, timeAccuracyOverride: '' })}
            error={errors.timeH}
            placeholder="0"
          />
          <NumberField
            id="calc-time-m"
            label={t('calculator.printingTimeMin')}
            value={state.timeM}
            onChange={(v) => set({ timeM: v, timeFromEstimate: false, timeAccuracyOverride: '' })}
            error={errors.timeM}
            placeholder="0"
          />
        </div>
        {showTimeCorrection && timeAccuracy && (
          <div className="flex items-center gap-2 text-xs rounded-full bg-blue-500/10 text-blue-400 px-3 py-1.5 w-fit">
            <Timer className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
            {timeAccuracy.scope
              ? t('calculator.timeCorrection.hintScoped', {
                  scope: timeAccuracy.scope,
                  pct: timeAccuracy.accuracy_pct.toFixed(0),
                })
              : t('calculator.timeCorrection.hint', { pct: timeAccuracy.accuracy_pct.toFixed(0) })}
            <button type="button" onClick={applyTimeCorrection} className="font-medium hover:text-white transition-colors underline">
              {t('calculator.timeCorrection.apply')}
            </button>
            <button
              type="button"
              aria-label={t('calculator.timeCorrection.dismiss')}
              onClick={() => set({ timeFromEstimate: false })}
              className="hover:text-white transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {num(state.energyKwh) > 0 && (
          <div className="flex items-center gap-2 text-xs rounded-full bg-bambu-green/10 text-bambu-green px-3 py-1.5 w-fit">
            <Zap className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
            {t('calculator.measuredEnergy', { kwh: state.energyKwh })}
            <button
              type="button"
              aria-label={t('calculator.measuredEnergyClear')}
              onClick={() => set({ energyKwh: '' })}
              className="hover:text-white transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        <div>
          <label htmlFor="calc-filament" className={labelCls}>
            {t('calculator.filament')}
          </label>
          <SearchableSelect
            id="calc-filament"
            value={String(filament?.id ?? '')}
            onChange={(v) => set({ filamentId: Number(v) })}
            options={filaments.map((f) => ({ value: String(f.id), label: f.name }))}
            allowCustom={false}
          />
          {filament && (
            <p className="text-xs text-bambu-gray mt-1 flex items-center gap-1">
              <Tooltip content={t('calculator.difficultyTooltip')}>
                <Info className="w-3.5 h-3.5" aria-hidden="true" />
              </Tooltip>
              {t('calculator.difficulty')}:{' '}
              <span className="tabular-nums">{formatPct(filament.difficulty_pct / 100, 0)}</span>
            </p>
          )}
        </div>
        <div>
          <label htmlFor="calc-printer" className={labelCls}>
            {t('calculator.printer')}
          </label>
          <SearchableSelect
            id="calc-printer"
            value={String(printer?.id ?? '')}
            onChange={(v) => set({ printerId: Number(v) })}
            options={printers.map((p) => ({ value: String(p.id), label: p.name }))}
            allowCustom={false}
          />
        </div>
      </CardContent>
    </Card>
  );
}
