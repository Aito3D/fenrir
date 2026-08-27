// Margin-curve tab of the calculator settings: the six parameters of the
// size-margin × quantity-discount model (utils/pricing.ts) plus the task
// floor, with a live preview drawn from the UNSAVED form values so the
// operator sees what they are about to save.

import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, type CalculatorDefaults } from '../../api/client';
import { Button } from '../Button';
import { Card, CardContent, CardHeader } from '../Card';
import { NumberField } from '../NumberField';
import { getCurrencySymbol } from '../../utils/currency';
import { CURVE_DEFAULTS, formatMoney, qtyFactor, sizeMargin, type PricingDefaults } from '../../utils/pricing';
import { parseNum, useDefaultsForm } from './calculatorSettingsShared';

type CurveKey = keyof typeof CURVE_DEFAULTS;

type CurveField = {
  key: CurveKey;
  labelKey: string;
  /** Mirrors the ge/le (or gt) bound in CalculatorDefaultsUpdate
   *  (backend/app/schemas/calculator.py). `exclusiveMin` marks a `gt` bound. */
  min: number;
  max: number;
  exclusiveMin?: boolean;
};

const MONEY_CEILING = 100_000_000;

const GROUPS: Array<{ labelKey: string; fields: CurveField[] }> = [
  {
    labelKey: 'calculator.sizeMarginGroup',
    fields: [
      { key: 'margin_min_mult', labelKey: 'calculator.marginMinMult', min: 1, max: 100 },
      { key: 'margin_max_mult', labelKey: 'calculator.marginMaxMult', min: 1, max: 100 },
      { key: 'margin_k', labelKey: 'calculator.marginK', min: 0, max: MONEY_CEILING, exclusiveMin: true },
    ],
  },
  {
    labelKey: 'calculator.qtyDiscountGroup',
    fields: [
      { key: 'qty_min_factor', labelKey: 'calculator.qtyMinFactor', min: 0, max: 1, exclusiveMin: true },
      { key: 'qty_k', labelKey: 'calculator.qtyK', min: 0, max: 1_000_000, exclusiveMin: true },
    ],
  },
  {
    labelKey: 'calculator.floorGroup',
    fields: [{ key: 'min_task_price', labelKey: 'calculator.minTaskPrice', min: 0, max: MONEY_CEILING }],
  },
];
const FIELDS: CurveField[] = GROUPS.flatMap((g) => g.fields);
const FIELD_KEYS: CurveKey[] = FIELDS.map(({ key }) => key);

const formValues = (d: CalculatorDefaults): Record<CurveKey, string> =>
  Object.fromEntries(FIELDS.map(({ key }) => [key, String(d[key])])) as Record<CurveKey, string>;

/** The form as PricingDefaults for the preview — unparsable fields fall
 *  back to the saved value so the chart never goes blank mid-edit. */
function previewDefaults(form: Record<CurveKey, string>, saved: CalculatorDefaults): PricingDefaults {
  const overrides: Partial<PricingDefaults> = {};
  for (const { key } of FIELDS) {
    const n = parseNum(form[key]);
    if (n !== null) overrides[key] = n;
  }
  return { ...saved, ...overrides };
}

const SIZE_STRIP = [0.25, 0.5, 1, 2, 4, 10]; // × K
const QTY_STRIP = [1, 2, 5, 10, 20, 50, 100];

function Preview({ d, currency }: { d: PricingDefaults; currency: string }) {
  const { t } = useTranslation();
  const k = d.margin_k ?? CURVE_DEFAULTS.margin_k;
  const kq = d.qty_k ?? CURVE_DEFAULTS.qty_k;
  const sizeData = useMemo(() => {
    const maxU = k * 10;
    return Array.from({ length: 41 }, (_, i) => {
      const u = (maxU * i) / 40;
      return { u, m: sizeMargin(u, d) };
    });
  }, [d, k]);
  const qtyData = useMemo(
    () => Array.from({ length: 100 }, (_, i) => ({ q: i + 1, f: qtyFactor(i + 1, d) })),
    [d],
  );
  // The fixed ladder plus the model's own reference quantity (KQ + 1, the
  // same point the ReferenceLine below marks — where the discount is
  // halfway to Q_MIN), inserted in sorted position and deduped so it never
  // shows up twice when it happens to coincide with a ladder rung.
  const midQty = kq + 1;
  const qtyStrip = useMemo(
    () => Array.from(new Set([...QTY_STRIP, midQty])).sort((a, b) => a - b),
    [midQty],
  );
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div>
        <div className="text-xs font-medium text-bambu-gray uppercase tracking-wide mb-2">{t('calculator.marginCurvePreviewSize')}</div>
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={sizeData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--color-bambu-dark-tertiary)" strokeDasharray="3 3" />
            <XAxis dataKey="u" type="number" domain={[0, k * 10]} tickFormatter={(v: number) => formatMoney(v, currency, false)} tick={{ fontSize: 11 }} stroke="var(--color-bambu-gray)" />
            <YAxis domain={['auto', 'auto']} tickFormatter={(v: number) => `×${v.toFixed(2)}`} tick={{ fontSize: 11 }} width={52} stroke="var(--color-bambu-gray)" />
            <Tooltip
              formatter={(v: number | undefined) => `×${Number(v ?? 0).toFixed(3)}`}
              labelFormatter={(u: ReactNode) => formatMoney(Number(u ?? 0), currency)}
            />
            <ReferenceLine x={k} stroke="var(--color-bambu-gray)" strokeDasharray="2 2" />
            <Line type="monotone" dataKey="m" stroke="var(--viz-1)" dot={false} strokeWidth={2} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
        <dl className="mt-2 grid grid-cols-6 gap-1 text-center">
          {SIZE_STRIP.map((f) => (
            <div key={f}>
              <dt className="text-[11px] text-bambu-gray tabular-nums">{formatMoney(k * f, currency, false)}</dt>
              <dd className="text-sm text-white tabular-nums">{`×${sizeMargin(k * f, d).toFixed(3)}`}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div>
        <div className="text-xs font-medium text-bambu-gray uppercase tracking-wide mb-2">{t('calculator.marginCurvePreviewQty')}</div>
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={qtyData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--color-bambu-dark-tertiary)" strokeDasharray="3 3" />
            <XAxis dataKey="q" type="number" domain={[1, 100]} tick={{ fontSize: 11 }} stroke="var(--color-bambu-gray)" />
            <YAxis domain={[0, 1]} tickFormatter={(v: number) => v.toFixed(2)} tick={{ fontSize: 11 }} width={40} stroke="var(--color-bambu-gray)" />
            <Tooltip formatter={(v: number | undefined) => Number(v ?? 0).toFixed(3)} />
            <ReferenceLine x={kq + 1} stroke="var(--color-bambu-gray)" strokeDasharray="2 2" />
            <Line type="monotone" dataKey="f" stroke="var(--viz-2)" dot={false} strokeWidth={2} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
        <dl
          className="mt-2 grid gap-1 text-center"
          style={{ gridTemplateColumns: `repeat(${qtyStrip.length}, minmax(0, 1fr))` }}
        >
          {qtyStrip.map((q) => {
            const isMid = q === midQty;
            return (
              <div key={q}>
                <dt className={`text-[11px] tabular-nums ${isMid ? 'text-bambu-green' : 'text-bambu-gray'}`}>{q}</dt>
                <dd className="text-sm text-white tabular-nums">{qtyFactor(q, d).toFixed(2)}</dd>
              </div>
            );
          })}
        </dl>
      </div>
    </div>
  );
}

function CurveForm({ defaults, currencySymbol, currency, canUpdate }: { defaults: CalculatorDefaults; currencySymbol: string; currency: string; canUpdate: boolean }) {
  const { t } = useTranslation();
  // Dirty/refetch/save mechanics (follow-server-until-dirty, PATCH only this
  // form's own fields, invalidate + toast + adopt-and-undirty on success) are
  // shared with CalculatorDefaultsPanel — see useDefaultsForm.
  const { form, setField, save, isPending } = useDefaultsForm(
    { fields: FIELD_KEYS, toForm: formValues, savedMsgKey: 'calculator.marginCurveSaved' },
    defaults,
  );

  const inRange = ({ min, max, exclusiveMin }: CurveField, n: number) => (exclusiveMin ? n > min : n >= min) && n <= max;
  const fieldErrors: Partial<Record<CurveKey, string>> = {};
  for (const field of FIELDS) {
    const n = parseNum(form[field.key]);
    if (n !== null && !inRange(field, n)) fieldErrors[field.key] = t('calculator.valRange', { min: field.min, max: field.max });
  }
  const mMin = parseNum(form.margin_min_mult);
  const mMax = parseNum(form.margin_max_mult);
  const pairError = mMin !== null && mMax !== null && mMax < mMin ? t('calculator.marginCurveMaxBelowMin') : undefined;
  if (pairError && !fieldErrors.margin_max_mult) fieldErrors.margin_max_mult = pairError;
  const allValid = FIELDS.every((f) => {
    const n = parseNum(form[f.key]);
    return n !== null && inRange(f, n);
  }) && !pairError;

  const preview = useMemo(() => previewDefaults(form, defaults), [form, defaults]);

  return (
    <form
      autoComplete="off"
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (allValid && canUpdate) save();
      }}
    >
      <Card className="animate-calc-rise">
        <CardHeader>
          <h2 className="font-semibold text-white">{t('calculator.tabMarginCurve')}</h2>
          <p className="text-sm text-bambu-gray mt-1">{t('calculator.marginCurveHint')}</p>
        </CardHeader>
        <CardContent className="space-y-5">
          {GROUPS.map((group) => (
            <div key={group.labelKey}>
              <div className="text-xs font-medium text-bambu-gray uppercase tracking-wide mb-2">{t(group.labelKey)}</div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {group.fields.map(({ key, labelKey }) => (
                  <NumberField
                    key={key}
                    id={`calc-curve-${key}`}
                    label={t(labelKey, { currency: currencySymbol })}
                    value={form[key]}
                    onChange={(v) => setField(key, v)}
                    error={fieldErrors[key]}
                    required
                  />
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card className="animate-calc-rise" style={{ animationDelay: '50ms' }}>
        <CardContent>
          <Preview d={preview} currency={currency} />
        </CardContent>
      </Card>
      {canUpdate && (
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={!allValid || isPending}>
            {isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {t('calculator.saveMarginCurve')}
          </Button>
        </div>
      )}
    </form>
  );
}

export function CalculatorMarginCurvePanel({ canUpdate }: { canUpdate: boolean }) {
  const { data: defaults } = useQuery({ queryKey: ['calculatorDefaults'], queryFn: api.getCalculatorDefaults, staleTime: 60_000 });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const currency = settings?.currency || 'USD';
  return (
    <div className="max-w-4xl">
      {defaults ? (
        <CurveForm defaults={defaults} currencySymbol={getCurrencySymbol(currency)} currency={currency} canUpdate={canUpdate} />
      ) : (
        <Card className="animate-calc-rise">
          <CardContent>
            <Loader2 className="w-5 h-5 animate-spin text-bambu-gray" />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
