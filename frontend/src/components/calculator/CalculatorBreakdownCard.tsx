import { useTranslation } from 'react-i18next';
import { PieChart } from 'lucide-react';
import { Card, CardContent, CardHeader } from '../Card';
import { CostSplitBar, Money, SegmentLegend, type Segment } from './shared';
import type { PricingResult } from '../../utils/pricing';

/** Per-unit cost lines grouped like the split bar. With quantity > 1 the
 *  modeling/preparation lines are the amortized per-unit share, so every
 *  group still sums to costs_so_far. */
export function CalculatorBreakdownCard({
  result,
  segments,
  currency,
}: {
  result: PricingResult;
  segments: Segment[];
  currency: string;
}) {
  const { t } = useTranslation();

  const groups: Array<{ labelKey: string; color: string; lines: Array<[string, number]> }> = [
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
  ];

  return (
    <Card className="animate-calc-rise" style={{ animationDelay: '150ms' }}>
      <CardHeader>
        <h2 className="font-semibold text-white flex items-center gap-2">
          <PieChart className="w-4 h-4 text-bambu-gray" />
          {t('calculator.breakdown')}
        </h2>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <CostSplitBar segments={segments} total={result.costs_so_far} currency={currency} />
          <SegmentLegend segments={segments} total={result.costs_so_far} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
          {groups.map((group) => (
            <div key={group.labelKey}>
              <div className="flex items-center gap-1.5 text-xs font-medium text-bambu-gray uppercase tracking-wide mb-2">
                <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: group.color }} />
                {t(group.labelKey)}
              </div>
              <div className="space-y-1">
                {group.lines.map(([labelKey, value]) => (
                  <div key={labelKey} className="flex justify-between gap-2 text-sm">
                    <span className="text-bambu-gray-light">{t(labelKey)}</span>
                    <Money currency={currency} value={value} className="text-white" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
