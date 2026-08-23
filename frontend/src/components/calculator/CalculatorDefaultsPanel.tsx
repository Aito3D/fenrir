// Global defaults tab of the calculator settings: electricity/labor/markup
// rates plus the prefill defaults for new filament profiles. Split out of
// the former CalculatorSettingsPanels.tsx (T-078).

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { api, type CalculatorDefaults } from '../../api/client';
import { Button } from '../Button';
import { Card, CardContent, CardHeader } from '../Card';
import { NumberField } from '../NumberField';
import { getCurrencySymbol } from '../../utils/currency';
import { useToast } from '../../contexts/ToastContext';
import { parseNum } from './calculatorSettingsShared';

type DefaultsField = { key: keyof Omit<CalculatorDefaults, 'id' | 'updated_at'>; labelKey: string };

const DEFAULTS_FIELDS_GENERAL: DefaultsField[] = [
  { key: 'electricity_tariff', labelKey: 'calculator.electricityTariff' },
  { key: 'labor_rate_per_hour', labelKey: 'calculator.laborRate' },
  { key: 'consumables_packaging_flat', labelKey: 'calculator.consumablesFlat' },
  { key: 'base_fee_flat', labelKey: 'calculator.baseFee' },
  { key: 'failure_rate_pct', labelKey: 'calculator.failureRate' },
  { key: 'prototype_rate_pct', labelKey: 'calculator.prototypeRate' },
  { key: 'ads_rate_pct', labelKey: 'calculator.adsRate' },
  { key: 'filament_markup_pct', labelKey: 'calculator.filamentMarkup' },
  { key: 'global_markup_pct', labelKey: 'calculator.globalMarkup' },
  { key: 'tax_pct', labelKey: 'calculator.taxPct' },
  { key: 'stuff_markup_pct', labelKey: 'calculator.stuffMarkup' },
];

// Prefill values for new filament profiles — shown in their own card.
const DEFAULTS_FIELDS_FILAMENT: DefaultsField[] = [
  { key: 'default_difficulty_pct', labelKey: 'calculator.defaultDifficulty' },
  { key: 'default_margin_over_cost_pct', labelKey: 'calculator.defaultMargin' },
];

const DEFAULTS_FIELDS: DefaultsField[] = [...DEFAULTS_FIELDS_GENERAL, ...DEFAULTS_FIELDS_FILAMENT];

const defaultsFormValues = (defaults: CalculatorDefaults): Record<string, string> =>
  Object.fromEntries(DEFAULTS_FIELDS.map(({ key }) => [key, String(defaults[key])]));

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
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Record<string, string>>(() => defaultsFormValues(defaults));
  // Tracks whether the operator has touched a field since the form was last
  // seeded (either on mount or after their own save). While untouched, the
  // form keeps following the server row — e.g. a save from another session.
  // Once dirty, a background refetch (like the invalidation this same panel
  // triggers on save) must not blow away in-progress typing.
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) setForm(defaultsFormValues(defaults));
  }, [defaults, dirty]);

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload: Record<string, number> = {};
      for (const { key } of DEFAULTS_FIELDS) {
        const n = parseNum(form[key]);
        if (n !== null) payload[key] = n;
      }
      return api.updateCalculatorDefaults(payload);
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ['calculatorDefaults'] });
      showToast(t('calculator.defaultsSaved'));
      // Adopt the operator's own successful save and clear dirty — otherwise
      // the form would look perpetually dirty and ignore the very refetch
      // its own save just triggered.
      setForm(defaultsFormValues(saved));
      setDirty(false);
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const allValid = DEFAULTS_FIELDS.every(({ key }) => {
    const n = parseNum(form[key]);
    return n !== null && n >= 0;
  });

  const setField = (key: string, v: string) => {
    setDirty(true);
    setForm((f) => ({ ...f, [key]: v }));
  };

  const renderFields = (fields: DefaultsField[]) => (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {fields.map(({ key, labelKey }) => (
        <NumberField
          key={key}
          id={`calc-def-${key}`}
          label={t(labelKey, { currency: currencySymbol })}
          value={form[key]}
          onChange={(v) => setField(key, v)}
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
        if (allValid && canUpdate) saveMutation.mutate();
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
          <Button type="submit" size="sm" disabled={!allValid || saveMutation.isPending}>
            {saveMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
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
