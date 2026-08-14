import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { CostSplitBar, SegmentLegend, Money } from '../calculator/shared';
import type { Segment } from '../calculator/shared';
import type { PricingResult } from '../../utils/pricing';

export interface ImpressionCostBandProps {
  /** The calculator's verdict on the current print parameters, or `null` when
   *  it could not price them (any of printer, filament, weight or time
   *  missing — an imported task looks exactly like that). */
  result: PricingResult | null;
  /** Which half of the calculator's reference data is empty, when one is. The
   *  band carries this message because C4 removed the toggle it used to hang
   *  off. `null` while the queries are still in flight: printers and filaments
   *  both start as `[]`, so an ungated check asserts "not configured" for the
   *  whole cold-cache window. */
  notConfigured: 'printers' | 'filaments' | null;
  /** The figure the quote line will carry — unit × quantity, less the
   *  discount. `null` renders no amount: an absent cost is not a zero cost. */
  lineTotal: number | null;
  currency: string;
}

/** The Impression3D block's footer band: how the price splits on the left, the
 *  line total on the right.
 *
 *  Stateless by construction — everything it draws is derived from `result`.
 *  Both halves always have content, which is the point of the band: the empty
 *  right column it replaced was the original bug. */
export function ImpressionCostBand({ result, notConfigured, lineTotal, currency }: ImpressionCostBandProps) {
  const { t } = useTranslation();

  // The bar splits the PRICE, margin included: in a quoting context the
  // useful reading is "of the 8 750 F charged, 1 200 is filament and 6 400 is
  // margin". Deliberately not CalculatorPage's segment list, which splits
  // `total_cost` and carries labor and base-fee segments that
  // `computeImpressionCost` forces to zero.
  //
  // These six sum to EXACTLY `total_ht`, which is why the bar always fills:
  // cost_subtotal here is machine + prototype + failures (labor, base fee,
  // consumables and stuff are all zeroed for an impression), plus ads, plus
  // marge. If that ever stops holding the bar will grow a gap.
  const segments: Segment[] = useMemo(() => {
    if (!result) return [];
    return [
      { key: 'filament', label: t('calculator.costFilament'), value: result.filament_cost, color: 'var(--viz-1)' },
      {
        key: 'printer',
        label: t('calculator.splitPrinter'),
        value: result.depreciation_cost + result.repairs_cost,
        color: 'var(--viz-2)',
      },
      { key: 'energy', label: t('calculator.costEnergy'), value: result.energy_cost, color: 'var(--viz-3)' },
      {
        key: 'provisions',
        label: t('calculator.groupProvisions'),
        value: result.prototype_cost + result.failures_cost,
        color: 'var(--viz-4)',
      },
      { key: 'ads', label: t('calculator.costAds'), value: result.ads_cost, color: 'var(--viz-5)' },
      { key: 'marge', label: t('calculator.marge'), value: result.marge, color: 'var(--viz-6)' },
    ].filter((s) => s.value > 0.005);
  }, [result, t]);

  return (
    <div
      className="impression-band flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-t border-bambu-dark-tertiary pt-2"
      data-testid="impression-band"
    >
      {/* Left half always has content — this is the half that used to go
          blank whenever no price could be computed. */}
      <div className="min-w-36 flex-1 space-y-1">
        {notConfigured !== null ? (
          <p className="text-sm text-bambu-gray">
            {t(notConfigured === 'printers' ? 'aito.noPrintersConfigured' : 'aito.noFilamentsConfigured')}{' '}
            <Link to="/calculator" className="text-bambu-green hover:underline">
              {t('calculator.title')}
            </Link>
          </p>
        ) : result ? (
          <>
            <CostSplitBar segments={segments} total={result.total_ht} currency={currency} />
            <SegmentLegend segments={segments} total={result.total_ht} />
            <details className="pt-1">
              <summary className="cursor-pointer text-xs text-bambu-gray marker:text-bambu-gray">
                {t('aito.costDetail')}
              </summary>
              <div className="mt-1 space-y-1">
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
                <div className="flex justify-between gap-2 pt-1 text-sm font-medium">
                  <span className="text-white">{t('calculator.totalTTC')}</span>
                  <Money currency={currency} value={result.total_ttc} className="text-bambu-green" />
                </div>
              </div>
            </details>
          </>
        ) : (
          <p className="text-sm text-bambu-gray">{t('aito.missingPrintParams')}</p>
        )}
      </div>

      {lineTotal !== null && (
        <div className="text-right">
          <Money currency={currency} value={lineTotal} className="text-lg font-semibold text-bambu-green" />
          <div className="text-[0.7rem] uppercase tracking-wide text-bambu-gray">{t('aito.printingTotal')}</div>
        </div>
      )}
    </div>
  );
}
