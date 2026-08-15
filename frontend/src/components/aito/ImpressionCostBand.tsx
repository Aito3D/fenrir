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
  /** What ONE part costs once the discount is taken off, or `null` when no
   *  discount is set. Undiscounted, the Cost input already states the unit
   *  price and repeating it here would be noise — but a discount only ever
   *  showed up in the total, leaving the operator to divide by the quantity
   *  in their head to quote a per-piece rate. */
  discountedUnit: number | null;
  currency: string;
}

/** The Impression3D block's footer band: how the price splits on the left, the
 *  line total on the right.
 *
 *  Stateless by construction — everything it draws is derived from `result`.
 *  Either half may be empty (an imported task has a total and no split; a
 *  half-filled one has neither), in which case the band draws only what it
 *  has, or nothing at all — the rule it hangs off is not worth a stray line
 *  across an empty row. It no longer explains what to fill in: the operator
 *  filling the form in knows. */
export function ImpressionCostBand({
  result,
  notConfigured,
  lineTotal,
  discountedUnit,
  currency,
}: ImpressionCostBandProps) {
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

  // Nothing computed, nothing configured to complain about and no total to
  // state: there is no band, only its border. Drawn, that reads as a rule
  // under an empty row.
  if (notConfigured === null && !result && lineTotal === null) return null;

  return (
    <div
      className="impression-band flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-t border-bambu-dark-tertiary pt-2"
      data-testid="impression-band"
    >
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
        ) : null}
      </div>

      {lineTotal !== null && (
        <div className="ml-auto text-right">
          <Money currency={currency} value={lineTotal} className="text-lg font-semibold text-bambu-green" />
          <div className="text-[0.7rem] uppercase tracking-wide text-bambu-gray">{t('aito.printingTotal')}</div>
          {/* The per-piece rate the discount actually bought, spelled out so
              nobody divides the total by the quantity by hand. */}
          {discountedUnit !== null && (
            <div className="text-xs text-bambu-gray">
              <Money currency={currency} value={discountedUnit} className="text-bambu-gray-light" />{' '}
              {t('aito.perPart')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
