// Global defaults tab of the calculator settings: electricity/labor/markup
// rates plus the prefill defaults for new filament profiles. Split out of
// the former CalculatorSettingsPanels.tsx (T-078).

import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { api, type CalculatorDefaults } from '../../api/client';
import { Button } from '../Button';
import { Card, CardContent, CardHeader } from '../Card';
import { NumberField } from '../NumberField';
import { getCurrencySymbol } from '../../utils/currency';
import { parseNum, useDefaultsForm } from './calculatorSettingsShared';

type DefaultsField = {
  key: keyof Omit<CalculatorDefaults, 'id' | 'updated_at'>;
  labelKey: string;
  /** Mirrors the field's `ge`/`le` bound in `CalculatorDefaultsUpdate`
   *  (backend/app/schemas/calculator.py) — kept in sync manually since the
   *  frontend has no build-time access to the pydantic schema. Pinned by
   *  ../../__tests__/components/CalculatorSettingsPanels.test.tsx, which
   *  drives each field's rendered input directly to its bound rather than
   *  importing this table (kept module-private so it doesn't widen this
   *  component's exported surface). */
  min: number;
  max: number;
};

// Ceiling shared by every unbounded money/rate field server-side
// (`_MONEY_CEILING` in backend/app/schemas/calculator.py) — a generous but
// finite cap, not a realistic input.
const MONEY_CEILING = 100_000_000;

const DEFAULTS_FIELDS_GENERAL: DefaultsField[] = [
  { key: 'electricity_tariff', labelKey: 'calculator.electricityTariff', min: 0, max: MONEY_CEILING },
  { key: 'labor_rate_per_hour', labelKey: 'calculator.laborRate', min: 0, max: MONEY_CEILING },
  { key: 'consumables_packaging_flat', labelKey: 'calculator.consumablesFlat', min: 0, max: MONEY_CEILING },
  { key: 'base_fee_flat', labelKey: 'calculator.baseFee', min: 0, max: MONEY_CEILING },
  { key: 'failure_rate_pct', labelKey: 'calculator.failureRate', min: 0, max: 1000 },
  { key: 'prototype_rate_pct', labelKey: 'calculator.prototypeRate', min: 0, max: 1000 },
  { key: 'ads_rate_pct', labelKey: 'calculator.adsRate', min: 0, max: 1000 },
  { key: 'filament_markup_pct', labelKey: 'calculator.filamentMarkup', min: 0, max: 1000 },
  { key: 'tax_pct', labelKey: 'calculator.taxPct', min: 0, max: 100 },
  { key: 'stuff_markup_pct', labelKey: 'calculator.stuffMarkup', min: 0, max: 1000 },
];

// Prefill values for new filament profiles — shown in their own card.
// `default_difficulty_pct` is bounded `ge=100` server-side (100 = no
// surcharge is the floor, not an ordinary non-negative number) — the field
// most likely to trip an operator who reads it as a plain percentage.
const DEFAULTS_FIELDS_FILAMENT: DefaultsField[] = [
  { key: 'default_difficulty_pct', labelKey: 'calculator.defaultDifficulty', min: 100, max: 1000 },
  { key: 'default_margin_over_cost_pct', labelKey: 'calculator.defaultMargin', min: 0, max: 1000 },
];

const DEFAULTS_FIELDS: DefaultsField[] = [...DEFAULTS_FIELDS_GENERAL, ...DEFAULTS_FIELDS_FILAMENT];

type DefaultsKey = DefaultsField['key'];

const DEFAULTS_FIELD_KEYS: DefaultsKey[] = DEFAULTS_FIELDS.map(({ key }) => key);

const defaultsFormValues = (defaults: CalculatorDefaults): Record<DefaultsKey, string> =>
  Object.fromEntries(DEFAULTS_FIELDS.map(({ key }) => [key, String(defaults[key])])) as Record<DefaultsKey, string>;

function DefaultsForm({
  defaults,
  currencySymbol,
  canUpdate,
}: {
  defaults: CalculatorDefaults;
  currencySymbol: string;
  /** Gates the Save control — this form's only write. The fields themselves
   *  stay visible/readable regardless (mirrors backend read/write split —
   *  Permission.CALCULATOR_UPDATE only guards the PATCH). */
  canUpdate: boolean;
}) {
  const { t } = useTranslation();
  // Dirty/refetch/save mechanics (follow-server-until-dirty, PATCH only this
  // form's own fields, invalidate + toast + adopt-and-undirty on success) are
  // shared with CalculatorMarginCurvePanel — see useDefaultsForm.
  const { form, setField, save, isPending } = useDefaultsForm(
    { fields: DEFAULTS_FIELD_KEYS, toForm: defaultsFormValues, savedMsgKey: 'calculator.defaultsSaved' },
    defaults,
  );

  // Per-field range errors — only for a value that parses but falls outside
  // the field's server-side bound. An empty field is left error-free here
  // (same as before this fix): it's still caught by `allValid` below and by
  // NumberField's own `required`, but flagging it with an "out of range"
  // message would misdescribe the problem.
  const fieldErrors = DEFAULTS_FIELDS.reduce<Partial<Record<string, string>>>((errs, { key, min, max }) => {
    const n = parseNum(form[key]);
    if (n !== null && (n < min || n > max)) {
      errs[key] = t('calculator.valRange', { min, max });
    }
    return errs;
  }, {});

  const allValid = DEFAULTS_FIELDS.every(({ key, min, max }) => {
    const n = parseNum(form[key]);
    return n !== null && n >= min && n <= max;
  });

  const renderFields = (fields: DefaultsField[]) => (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {fields.map(({ key, labelKey }) => (
        <NumberField
          key={key}
          id={`calc-def-${key}`}
          label={t(labelKey, { currency: currencySymbol })}
          value={form[key]}
          onChange={(v) => setField(key, v)}
          error={fieldErrors[key]}
          required
        />
      ))}
    </div>
  );

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
          <h2 className="font-semibold text-white">{t('calculator.tabDefaults')}</h2>
          <p className="text-sm text-bambu-gray mt-1">{t('calculator.defaultsHint')}</p>
        </CardHeader>
        <CardContent>{renderFields(DEFAULTS_FIELDS_GENERAL)}</CardContent>
      </Card>
      <Card className="animate-calc-rise" style={{ animationDelay: '50ms' }}>
        <CardHeader>
          <h2 className="font-semibold text-white">{t('calculator.filamentSettings')}</h2>
          <p className="text-sm text-bambu-gray mt-1">{t('calculator.filamentSettingsHint')}</p>
        </CardHeader>
        <CardContent>{renderFields(DEFAULTS_FIELDS_FILAMENT)}</CardContent>
      </Card>
      {canUpdate && (
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={!allValid || isPending}>
            {isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {t('calculator.saveDefaults')}
          </Button>
        </div>
      )}
    </form>
  );
}

export function CalculatorDefaultsPanel({ canUpdate }: { canUpdate: boolean }) {
  const { data: defaults } = useQuery({
    queryKey: ['calculatorDefaults'],
    queryFn: api.getCalculatorDefaults,
    staleTime: 60_000,
  });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const currencySymbol = getCurrencySymbol(settings?.currency || 'USD');

  return (
    <div className="max-w-4xl">
      {defaults ? (
        <DefaultsForm defaults={defaults} currencySymbol={currencySymbol} canUpdate={canUpdate} />
      ) : (
        <Card className="animate-calc-rise">
          <CardContent>
            <div className="flex justify-center py-8">
              <Loader2 className="w-6 h-6 text-bambu-green animate-spin" />
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
