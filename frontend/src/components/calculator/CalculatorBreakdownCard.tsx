import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { PieChart } from 'lucide-react';
import { Card, CardContent, CardHeader } from '../Card';
import { Money } from './shared';
import { CostWaterfall } from './CostWaterfall';
import { buildWaterfall, type PricingResult } from '../../utils/pricing';

/** Per-unit cost lines grouped like the split bar. With quantity > 1 the
 *  modeling/preparation lines are the amortized per-unit share, so the cost
 *  groups sum to total_cost and the margin group to marge — together the
 *  pre-tax price. */
export function CalculatorBreakdownCard({
  result,
  currency,
}: {
  result: PricingResult;
  currency: string;
}) {
  const { t } = useTranslation();
  const waterfall = useMemo(() => buildWaterfall(result), [result]);

  const groups: Array<{
    labelKey: string;
    color: string;
    lines: Array<[string, number, string?, string?]>;
  }> = [
    {
      labelKey: 'calculator.groupMachine',
      color: 'var(--viz-1)',
      lines: [
        ['calculator.costFilament', result.filament_cost],
        ['calculator.costDepreciation', result.depreciation_cost],
        ['calculator.costEnergy', result.energy_cost],
        ['calculator.costRepairs', result.repairs_cost],
      ],
    },
    {
      labelKey: 'calculator.groupProvisions',
      color: 'var(--viz-4)',
      lines: [
        ['calculator.costPrototype', result.prototype_cost],
        ['calculator.costFailures', result.failures_cost],
      ],
    },
    {
      labelKey: 'calculator.groupOther',
      color: 'var(--viz-5)',
      lines: [
        ['calculator.costConsumables', result.consumables_flat],
        ['calculator.costBaseFee', result.base_fee],
        ['calculator.costAds', result.ads_cost],
      ],
    },
    {
      labelKey: 'calculator.groupLabor',
      color: 'var(--viz-6)',
      lines: [
        ['calculator.costModeling', result.modeling_cost],
        ['calculator.costPreparation', result.prep_cost],
        ['calculator.costPostProcessing', result.post_processing_cost],
        ['calculator.costStuff', result.stuff_cost],
      ],
    },
    {
      labelKey: 'calculator.marge',
      color: 'var(--color-bambu-green)',
      lines: [
        [
          'calculator.marginGlobal',
          result.margin_global,
          t('calculator.multiplier', { value: result.margin_multiplier.toFixed(2) }),
          t('calculator.multiplierDetail', { size: result.size_margin.toFixed(2), qty: result.qty_factor.toFixed(2) }),
        ],
        ['calculator.marginFilament', result.margin_filament],
        ['calculator.marginStuff', result.margin_stuff],
      ],
    },
  ];

  return (
    // Delay matches the house `stagger-children` 50ms cadence; kept inline
    // because this card and its siblings live in separate grid columns, not
    // one shared parent that `stagger-children` could be applied to.
    <Card className="animate-calc-rise" style={{ animationDelay: '50ms' }}>
      <CardHeader>
        <h2 className="font-semibold text-white flex items-center gap-2">
          <PieChart className="w-4 h-4 text-bambu-gray" />
          {t('calculator.breakdown')}
        </h2>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Full mode gets the waterfall (costs + margin + tax assembling the
            sale price); Easy mode keeps the simpler split bar on the totals
            card, so `segments` stays a prop for that path. */}
        <CostWaterfall steps={waterfall} currency={currency} />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
          {groups.map((group) => (
            <div key={group.labelKey}>
              <div className="flex items-center gap-1.5 text-xs font-medium text-bambu-gray uppercase tracking-wide mb-2">
                <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: group.color }} />
                {t(group.labelKey)}
              </div>
              <div className="space-y-1">
                {group.lines.map(([labelKey, value, badge, badgeTitle]) => (
                  <div key={labelKey} className="flex justify-between gap-2 text-sm">
                    <span className="text-bambu-gray-light">{t(labelKey)}</span>
                    <div className="flex items-center gap-1.5">
                      {badge && (
                        <span className="text-xs text-bambu-gray tabular-nums" title={badgeTitle}>
                          {badge}
                        </span>
                      )}
                      <Money currency={currency} value={value} className="text-white" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        {result.floor_applied && <p className="text-xs text-bambu-gray">{t('calculator.floorApplied')}</p>}
      </CardContent>
    </Card>
  );
}
