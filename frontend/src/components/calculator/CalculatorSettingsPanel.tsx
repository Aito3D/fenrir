// Settings tab of the calculator: every global pricing default, one card per
// group — rates, provisions & overhead, the margin curves (fields beside the
// live curves they shape) and the prefill values for new filament profiles —
// behind a single Save bar that appears only while something is dirty.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Percent, Receipt, Spool, TrendingDown, type LucideIcon } from 'lucide-react';
import { api, type CalculatorDefaults } from '../../api/client';
import { Button } from '../Button';
import { Card, CardContent, CardHeader } from '../Card';
import { NumberField } from '../NumberField';
import { getCurrencySymbol } from '../../utils/currency';
import { buildPricingInputs, foldSessionOverrides, loadCalculatorState } from '../../hooks/useCalculatorState';
import { computePricing, type PricingDefaults } from '../../utils/pricing';
import { MarginCurvePreview } from './MarginCurvePreview';
import { parseNum, useDefaultsForm } from './calculatorSettingsShared';

type FieldKey = keyof Omit<CalculatorDefaults, 'id' | 'updated_at' | 'global_markup_pct'>;

type Field = {
  key: FieldKey;
  labelKey: string;
  /** Mirrors the field's `ge`/`le` (or `gt`) bound in `CalculatorDefaultsUpdate`
   *  (backend/app/schemas/calculator.py) — kept in sync by hand; pinned by
   *  ../../__tests__/components/CalculatorSettingsPanel.test.tsx, which drives
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

/** One settings card. The card rises with its `.stagger-parents` slot; its
 *  header lands with it and the fields inside cascade after (level 2 of the
 *  app's entrance hierarchy — see index.css). */
function SettingsCard({
  icon: Icon,
  title,
  hint,
  className = '',
  children,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
  /** Grid placement on wide screens (see the form's 12-column grid). */
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card className={`animate-rise-lg ${className}`}>
      <CardHeader>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-bambu-dark text-bambu-green" aria-hidden="true">
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-white">{title}</h3>
            <p className="mt-0.5 text-sm leading-relaxed text-bambu-gray">{hint}</p>
          </div>
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function SettingsForm({
  defaults,
  currency,
  canUpdate,
}: {
  defaults: CalculatorDefaults;
  currency: string;
  /** Gates the Save bar — this form's only write. The fields stay
   *  visible/readable regardless (mirrors the backend read/write split —
   *  Permission.CALCULATOR_UPDATE only guards the PATCH). */
  canUpdate: boolean;
}) {
  const { t } = useTranslation();
  const currencySymbol = getCurrencySymbol(currency);
  const { form, setField, dirtyKeys, save, discard, isPending } = useDefaultsForm(
    { fields: FIELD_KEYS, toForm: formValues, savedMsgKey: 'calculator.settingsSaved' },
    defaults,
  );

  // Example-job overlay on the margin curves: seeded once (K / quantity 1)
  // from the last persisted calculator job, once its filament and printer
  // are both loaded. Lives outside useDefaultsForm — editing it never dirties
  // the settings form.
  const { data: filaments } = useQuery({ queryKey: ['calculatorFilaments'], queryFn: api.getCalculatorFilaments, staleTime: 60_000 });
  const { data: printers } = useQuery({ queryKey: ['calculatorPrinters'], queryFn: api.getCalculatorPrinters, staleTime: 60_000 });
  const [example, setExample] = useState<{ unitCost: string; quantity: string }>({
    unitCost: String(defaults.margin_k),
    quantity: '1',
  });
  const [seeded, setSeeded] = useState(false);
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !filaments?.length || !printers?.length) return;
    seededRef.current = true;
    const s = loadCalculatorState();
    const filament = filaments.find((f) => f.id === s.filamentId);
    const printer = printers.find((p) => p.id === s.printerId);
    if (!filament || !printer) return;
    const inputs = buildPricingInputs(s, defaults);
    if (inputs.weight_g <= 0 || inputs.printing_time_h <= 0) return;
    const eff = foldSessionOverrides(s, defaults, printer, inputs);
    const r = computePricing(eff.inputs, filament, eff.printer, eff.defaults);
    setExample({ unitCost: String(Math.round(r.total_cost)), quantity: String(inputs.quantity) });
    setSeeded(true);
  }, [filaments, printers, defaults]);

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
  const barOpen = canUpdate && dirty;

  // The Save bar is fixed to the viewport, aligned to the form's own left
  // edge and width. `position: sticky` cannot do this here: the app's <main>
  // is an overflow container that grows past the window (the document
  // scrolls, not <main>), so a sticky bottom would measure against <main>'s
  // off-screen bottom edge and never engage.
  const formRef = useRef<HTMLFormElement>(null);
  const [barBox, setBarBox] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const el = formRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setBarBox(r.width > 0 ? { left: r.left, width: r.width } : null);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

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
  const grid = (fields: Field[], cols = 'sm:grid-cols-2') => (
    <div className={`stagger-nested grid grid-cols-1 gap-4 ${cols}`}>{fields.map(field)}</div>
  );

  return (
    <form
      ref={formRef}
      autoComplete="off"
      // Wide screens: a 12-column grid so the whole page fits without
      // scrolling — rates, provisions and the filament prefill share the top
      // row; the margin curves get the full width below so the charts read.
      className="stagger-parents grid grid-cols-1 gap-4 pb-20 xl:grid-cols-12"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && allValid && canUpdate) save();
      }}
    >
      <SettingsCard icon={Receipt} title={t('calculator.ratesTitle')} hint={t('calculator.ratesHint')} className="xl:col-span-4">
        {grid(RATES, 'sm:grid-cols-2')}
      </SettingsCard>

      <SettingsCard icon={Percent} title={t('calculator.provisionsTitle')} hint={t('calculator.provisionsHint')} className="xl:col-span-4">
        {grid(PROVISIONS, 'sm:grid-cols-2')}
      </SettingsCard>

      <SettingsCard icon={Spool} title={t('calculator.filamentSettings')} hint={t('calculator.filamentSettingsHint')} className="xl:col-span-4">
        {grid(PREFILL, 'sm:grid-cols-2 xl:grid-cols-1')}
      </SettingsCard>

      <SettingsCard
        icon={TrendingDown}
        title={t('calculator.marginCurvesTitle')}
        hint={t('calculator.marginCurveHint')}
        className="xl:col-span-12"
      >
        {/* Two panels: the curve fields and the curves they shape. The
            divider is a hairline on wide screens; the panels stack below.
            The charts take two thirds of the card. */}
        <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_1px_minmax(0,2fr)]">
          <div className="stagger-nested space-y-6">
            {MARGIN_GROUPS.map((group) => (
              <fieldset key={group.labelKey} className="min-w-0">
                <legend className="mb-3 text-[11px] font-medium uppercase tracking-[0.14em] text-bambu-gray">{t(group.labelKey)}</legend>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">{group.fields.map(field)}</div>
              </fieldset>
            ))}
          </div>
          <div className="hidden xl:block w-px bg-bambu-dark-tertiary" aria-hidden="true" />
          <MarginCurvePreview
            d={preview}
            currency={currency}
            example={example}
            onExampleChange={(p) => setExample((e) => ({ ...e, ...p }))}
            seededFromJob={seeded}
            onDragK={(v) => setField('margin_k', String(v))}
            onDragKQ={(v) => setField('qty_k', String(v))}
            readOnly={!canUpdate}
          />
        </div>
      </SettingsCard>

      {/* Save bar: mounted permanently so it leaves the way it arrived (slides
          back down), inert while closed; fixed to the viewport so it stays
          reachable from any card. Never rendered for read-only viewers. */}
      {canUpdate && (
        <div
          className="fixed bottom-4 z-10 pointer-events-none xl:col-span-12"
          style={barBox ? { left: barBox.left, width: barBox.width } : { left: '1rem', right: '1rem' }}
          aria-live="polite"
        >
          <div
            className="settings-save-bar flex flex-wrap items-center justify-between gap-3 rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary/95 px-4 py-3 shadow-xl backdrop-blur"
            data-open={barOpen ? 'true' : 'false'}
            aria-hidden={!barOpen}
          >
            <p className="text-sm text-bambu-gray-light">
              <span className="font-medium text-white tabular-nums">{t('calculator.unsavedChanges', { count: dirtyKeys.length })}</span>
              {!allValid && <span className="ml-2 text-status-error">{t('calculator.fixFields')}</span>}
            </p>
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={discard} disabled={isPending} tabIndex={barOpen ? 0 : -1}>
                {t('calculator.discardChanges')}
              </Button>
              <Button type="submit" size="sm" disabled={!allValid || isPending} tabIndex={barOpen ? 0 : -1}>
                {isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                {t('calculator.saveSettings')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}

export function CalculatorSettingsPanel({ canUpdate }: { canUpdate: boolean }) {
  const { data: defaults } = useQuery({ queryKey: ['calculatorDefaults'], queryFn: api.getCalculatorDefaults, staleTime: 60_000 });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const currency = settings?.currency || 'USD';
  return (
    <div>
      {defaults ? (
        <SettingsForm defaults={defaults} currency={currency} canUpdate={canUpdate} />
      ) : (
        <div className="flex justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-bambu-green" />
        </div>
      )}
    </div>
  );
}
