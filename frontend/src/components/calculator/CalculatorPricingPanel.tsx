// Pricing tab of the calculator settings: every global pricing default on
// one page — rates, provisions & overhead, the margin curves (with a live
// preview beside their fields) and the prefill values for new filament
// profiles — behind a single Save. Replaces the former Defaults and Margin
// curve tabs.

import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { api, type CalculatorDefaults } from '../../api/client';
import { Button } from '../Button';
import { NumberField } from '../NumberField';
import { getCurrencySymbol } from '../../utils/currency';
import type { PricingDefaults } from '../../utils/pricing';
import { MarginCurvePreview } from './MarginCurvePreview';
import { parseNum, useDefaultsForm } from './calculatorSettingsShared';

type FieldKey = keyof Omit<CalculatorDefaults, 'id' | 'updated_at' | 'global_markup_pct'>;

type Field = {
  key: FieldKey;
  labelKey: string;
  /** Mirrors the field's `ge`/`le` (or `gt`) bound in `CalculatorDefaultsUpdate`
   *  (backend/app/schemas/calculator.py) — kept in sync by hand; pinned by
   *  ../../__tests__/components/CalculatorPricingPanel.test.tsx, which drives
   *  each rendered input to its bound. `exclusiveMin` marks a `gt` bound. */
  min: number;
  max: number;
  exclusiveMin?: boolean;
};

// Ceiling shared by every unbounded money/rate field server-side
// (`_MONEY_CEILING` in backend/app/schemas/calculator.py).
const MONEY_CEILING = 100_000_000;

/** Input ids keep their historical prefixes (`calc-def-*` for the former
 *  Defaults fields, `calc-curve-*` for the curve) so deep links and tests
 *  written against either tab still resolve. */
const CURVE_KEYS = new Set<FieldKey>(['margin_min_mult', 'margin_max_mult', 'margin_k', 'qty_min_factor', 'qty_k', 'min_task_price']);
const inputId = (key: FieldKey) => `${CURVE_KEYS.has(key) ? 'calc-curve' : 'calc-def'}-${key}`;

const RATES: Field[] = [
  { key: 'electricity_tariff', labelKey: 'calculator.electricityTariff', min: 0, max: MONEY_CEILING },
  { key: 'labor_rate_per_hour', labelKey: 'calculator.laborRate', min: 0, max: MONEY_CEILING },
  { key: 'consumables_packaging_flat', labelKey: 'calculator.consumablesFlat', min: 0, max: MONEY_CEILING },
  { key: 'base_fee_flat', labelKey: 'calculator.baseFee', min: 0, max: MONEY_CEILING },
  { key: 'tax_pct', labelKey: 'calculator.taxPct', min: 0, max: 100 },
];

const PROVISIONS: Field[] = [
  { key: 'failure_rate_pct', labelKey: 'calculator.failureRate', min: 0, max: 1000 },
  { key: 'prototype_rate_pct', labelKey: 'calculator.prototypeRate', min: 0, max: 1000 },
  { key: 'ads_rate_pct', labelKey: 'calculator.adsRate', min: 0, max: 1000 },
  { key: 'filament_markup_pct', labelKey: 'calculator.filamentMarkup', min: 0, max: 1000 },
  { key: 'stuff_markup_pct', labelKey: 'calculator.stuffMarkup', min: 0, max: 1000 },
];

const MARGIN_GROUPS: Array<{ labelKey: string; fields: Field[] }> = [
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
const MARGIN: Field[] = MARGIN_GROUPS.flatMap((g) => g.fields);

// `default_difficulty_pct` is bounded `ge=100` server-side (100 = no
// surcharge is the floor, not an ordinary non-negative percentage).
const PREFILL: Field[] = [
  { key: 'default_difficulty_pct', labelKey: 'calculator.defaultDifficulty', min: 100, max: 1000 },
  { key: 'default_margin_over_cost_pct', labelKey: 'calculator.defaultMargin', min: 0, max: 1000 },
];

const FIELDS: Field[] = [...RATES, ...PROVISIONS, ...MARGIN, ...PREFILL];
const FIELD_KEYS: FieldKey[] = FIELDS.map(({ key }) => key);

const formValues = (d: CalculatorDefaults): Record<FieldKey, string> =>
  Object.fromEntries(FIELDS.map(({ key }) => [key, String(d[key])])) as Record<FieldKey, string>;

const inRange = ({ min, max, exclusiveMin }: Field, n: number) => (exclusiveMin ? n > min : n >= min) && n <= max;

/** The form as PricingDefaults for the preview — an unparsable field falls
 *  back to the saved value so the curves never go blank mid-edit. */
function previewDefaults(form: Record<FieldKey, string>, saved: CalculatorDefaults): PricingDefaults {
  const overrides: Record<string, number> = {};
  for (const { key } of MARGIN) {
    const n = parseNum(form[key]);
    if (n !== null) overrides[key] = n;
  }
  return { ...saved, ...overrides };
}

/** One settings section: title + hint in the leading column, controls in
 *  the trailing one; stacked on narrow screens. */
function Section({ title, hint, delay, children }: { title: string; hint: string; delay: number; children: ReactNode }) {
  return (
    <section
      className="animate-calc-rise grid gap-x-10 gap-y-4 py-8 border-t border-bambu-dark-tertiary first:border-t-0 first:pt-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,2.6fr)]"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="lg:pr-4">
        <h3 className="text-base font-semibold text-white">{title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-bambu-gray">{hint}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function PricingForm({
  defaults,
  currency,
  canUpdate,
}: {
  defaults: CalculatorDefaults;
  currency: string;
  /** Gates the Save control — this form's only write. The fields stay
   *  visible/readable regardless (mirrors the backend read/write split —
   *  Permission.CALCULATOR_UPDATE only guards the PATCH). */
  canUpdate: boolean;
}) {
  const { t } = useTranslation();
  const currencySymbol = getCurrencySymbol(currency);
  const { form, setField, dirtyKeys, save, discard, isPending } = useDefaultsForm(
    { fields: FIELD_KEYS, toForm: formValues, savedMsgKey: 'calculator.pricingSaved' },
    defaults,
  );

  // Per-field range errors — only for a value that parses but falls outside
  // its server-side bound. An empty field is caught by `allValid` and by
  // NumberField's own `required`; flagging it "out of range" would
  // misdescribe the problem.
  const fieldErrors: Partial<Record<FieldKey, string>> = {};
  for (const field of FIELDS) {
    const n = parseNum(form[field.key]);
    if (n !== null && !inRange(field, n)) fieldErrors[field.key] = t('calculator.valRange', { min: field.min, max: field.max });
  }
  const mMin = parseNum(form.margin_min_mult);
  const mMax = parseNum(form.margin_max_mult);
  const pairError = mMin !== null && mMax !== null && mMax < mMin ? t('calculator.marginCurveMaxBelowMin') : undefined;
  if (pairError && !fieldErrors.margin_max_mult) fieldErrors.margin_max_mult = pairError;
  const allValid =
    FIELDS.every((f) => {
      const n = parseNum(form[f.key]);
      return n !== null && inRange(f, n);
    }) && !pairError;

  const preview = useMemo(() => previewDefaults(form, defaults), [form, defaults]);
  const dirty = dirtyKeys.length > 0;

  const field = ({ key, labelKey }: Field) => (
    <NumberField
      key={key}
      id={inputId(key)}
      label={t(labelKey, { currency: currencySymbol })}
      value={form[key]}
      onChange={(v) => setField(key, v)}
      error={fieldErrors[key]}
      required
    />
  );
  const grid = (fields: Field[]) => <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">{fields.map(field)}</div>;

  return (
    <form
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && allValid && canUpdate) save();
      }}
    >
      <header className="animate-calc-rise mb-2">
        <h2 className="text-lg font-semibold text-white">{t('calculator.tabPricing')}</h2>
        <p className="mt-1 max-w-2xl text-sm text-bambu-gray">{t('calculator.pricingHint')}</p>
      </header>

      <Section title={t('calculator.ratesTitle')} hint={t('calculator.ratesHint')} delay={50}>
        {grid(RATES)}
      </Section>

      <Section title={t('calculator.provisionsTitle')} hint={t('calculator.provisionsHint')} delay={100}>
        {grid(PROVISIONS)}
      </Section>

      <Section title={t('calculator.marginTitle')} hint={t('calculator.marginCurveHint')} delay={150}>
        {/* The signature of the page: the curve fields and the curves they
            shape sit side by side, and the curves redraw as you type. */}
        <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <div className="space-y-6">
            {MARGIN_GROUPS.map((group) => (
              <fieldset key={group.labelKey} className="min-w-0">
                <legend className="mb-3 text-[11px] font-medium uppercase tracking-[0.14em] text-bambu-gray">{t(group.labelKey)}</legend>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-1">{group.fields.map(field)}</div>
              </fieldset>
            ))}
          </div>
          <MarginCurvePreview d={preview} currency={currency} />
        </div>
      </Section>

      <Section title={t('calculator.filamentSettings')} hint={t('calculator.filamentSettingsHint')} delay={200}>
        {grid(PREFILL)}
      </Section>

      {/* Save bar: present only while something is dirty and the operator
          may write. Sticky so it stays reachable from any section. */}
      {canUpdate && dirty && (
        <div className="sticky bottom-4 z-10 mt-4 animate-calc-rise">
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary/95 px-4 py-3 shadow-xl backdrop-blur"
          >
            <p className="text-sm text-bambu-gray-light">
              <span className="font-medium text-white">{t('calculator.unsavedChanges', { count: dirtyKeys.length })}</span>
              {!allValid && <span className="ml-2 text-status-error">{t('calculator.fixFields')}</span>}
            </p>
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={discard} disabled={isPending}>
                {t('calculator.discardChanges')}
              </Button>
              <Button type="submit" size="sm" disabled={!allValid || isPending}>
                {isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                {t('calculator.savePricing')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}

export function CalculatorPricingPanel({ canUpdate }: { canUpdate: boolean }) {
  const { data: defaults } = useQuery({ queryKey: ['calculatorDefaults'], queryFn: api.getCalculatorDefaults, staleTime: 60_000 });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const currency = settings?.currency || 'USD';
  return (
    <div className="max-w-5xl">
      {defaults ? (
        <PricingForm defaults={defaults} currency={currency} canUpdate={canUpdate} />
      ) : (
        <div className="flex justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-bambu-green" />
        </div>
      )}
    </div>
  );
}
