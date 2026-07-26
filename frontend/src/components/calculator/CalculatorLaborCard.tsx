import { useTranslation } from 'react-i18next';
import { Wrench } from 'lucide-react';
import type { CalculatorDefaults } from '../../api/client';
import { Card, CardContent, CardHeader } from '../Card';
import { Collapsible } from '../Collapsible';
import { NumberField } from '../NumberField';
import { Money } from './shared';
import type { PricingResult } from '../../utils/pricing';
import type { CalcState } from '../../hooks/useCalculatorState';

const sectionCls = 'rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-3 py-2.5';

/** Collapsible section header: contribution dot, label, current cost. */
function SectionSummary({ label, cost, currency }: { label: string; cost: number; currency: string }) {
  return (
    <span className="text-sm text-white flex items-center justify-between gap-2">
      <span className="flex items-center gap-2 min-w-0">
        <span
          aria-hidden="true"
          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${cost > 0 ? 'bg-bambu-green' : 'bg-bambu-dark-tertiary'}`}
        />
        {label}
      </span>
      <Money currency={currency} value={cost} className={cost > 0 ? 'text-bambu-gray' : 'text-bambu-gray/50'} />
    </span>
  );
}

export function CalculatorLaborCard({
  state,
  errors,
  set,
  result,
  defaults,
  currency,
  currencySymbol,
}: {
  state: CalcState;
  errors: Partial<Record<keyof CalcState, string>>;
  set: (patch: Partial<CalcState>) => void;
  result: PricingResult;
  defaults: CalculatorDefaults;
  currency: string;
  currencySymbol: string;
}) {
  const { t } = useTranslation();
  const showAmortized = result.quantity > 1 && result.modeling_cost_total + result.prep_cost_total > 0;
  return (
    // Delay matches the house `stagger-children` 50ms cadence; kept inline
    // because this card and its siblings live in separate grid columns, not
    // one shared parent that `stagger-children` could be applied to.
    <Card className="animate-calc-rise" style={{ animationDelay: '100ms' }}>
      <CardHeader>
        <h2 className="font-semibold text-white flex items-center gap-2">
          <Wrench className="w-4 h-4 text-bambu-gray" />
          {t('calculator.labor')}
        </h2>
      </CardHeader>
      <CardContent className="space-y-3">
        <Collapsible
          animated
          className={sectionCls}
          summary={<SectionSummary label={t('calculator.modeling')} cost={result.modeling_cost_total} currency={currency} />}
        >
          <div className="grid grid-cols-2 gap-3">
            <NumberField id="calc-mod-hours" label={t('calculator.workingHours')} unit={t('calculator.durationHoursShort')} value={state.modelingHours} onChange={(v) => set({ modelingHours: v })} error={errors.modelingHours} placeholder="0" />
            <NumberField id="calc-mod-base" label={t('calculator.basePrice')} unit={currencySymbol} value={state.modelingBasePrice} onChange={(v) => set({ modelingBasePrice: v })} error={errors.modelingBasePrice} placeholder="0" />
          </div>
        </Collapsible>
        <Collapsible
          animated
          className={sectionCls}
          summary={<SectionSummary label={t('calculator.preparation')} cost={result.prep_cost_total} currency={currency} />}
        >
          <div className="grid grid-cols-2 gap-3">
            <NumberField id="calc-prep-model" label={t('calculator.modelPreparation')} unit={t('calculator.durationMinutesShort')} value={state.prepModel} onChange={(v) => set({ prepModel: v })} error={errors.prepModel} placeholder="0" />
            <NumberField id="calc-prep-slicing" label={t('calculator.slicing')} unit={t('calculator.durationMinutesShort')} value={state.prepSlicing} onChange={(v) => set({ prepSlicing: v })} error={errors.prepSlicing} placeholder="0" />
            <NumberField id="calc-prep-transfer" label={t('calculator.transferStart')} unit={t('calculator.durationMinutesShort')} value={state.prepTransfer} onChange={(v) => set({ prepTransfer: v })} error={errors.prepTransfer} placeholder="0" />
          </div>
        </Collapsible>
        <Collapsible
          animated
          className={sectionCls}
          summary={<SectionSummary label={t('calculator.postProcessing')} cost={result.post_processing_cost} currency={currency} />}
        >
          <div className="grid grid-cols-2 gap-3">
            <NumberField id="calc-post-removal" label={t('calculator.jobRemoval')} unit={t('calculator.durationMinutesShort')} value={state.postRemoval} onChange={(v) => set({ postRemoval: v })} error={errors.postRemoval} placeholder="0" />
            <NumberField id="calc-post-support" label={t('calculator.supportRemoval')} unit={t('calculator.durationMinutesShort')} value={state.postSupport} onChange={(v) => set({ postSupport: v })} error={errors.postSupport} placeholder="0" />
            <NumberField id="calc-post-additional" label={t('calculator.additionalWork')} unit={t('calculator.durationMinutesShort')} value={state.postAdditional} onChange={(v) => set({ postAdditional: v })} error={errors.postAdditional} placeholder="0" />
            <NumberField id="calc-post-fulfillment" label={t('calculator.fulfillment')} unit={t('calculator.durationMinutesShort')} value={state.postFulfillment} onChange={(v) => set({ postFulfillment: v })} error={errors.postFulfillment} placeholder="0" />
          </div>
        </Collapsible>
        <Collapsible
          animated
          className={sectionCls}
          summary={<SectionSummary label={t('calculator.stuff')} cost={result.stuff_cost} currency={currency} />}
        >
          <div className="grid grid-cols-2 gap-3">
            <NumberField id="calc-stuff-amount" label={t('calculator.amount')} unit={currencySymbol} value={state.stuffAmount} onChange={(v) => set({ stuffAmount: v })} error={errors.stuffAmount} placeholder="0" />
            <NumberField id="calc-stuff-markup" label={t('calculator.markupPct')} unit="%" value={state.stuffMarkup} onChange={(v) => set({ stuffMarkup: v })} error={errors.stuffMarkup} placeholder={String(defaults.stuff_markup_pct)} />
          </div>
        </Collapsible>
        {showAmortized && (
          <p className="text-xs text-bambu-gray px-1">{t('calculator.laborAmortized', { count: result.quantity })}</p>
        )}
      </CardContent>
    </Card>
  );
}
