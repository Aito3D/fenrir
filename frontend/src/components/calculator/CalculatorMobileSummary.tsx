import { useTranslation } from 'react-i18next';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { Money } from './shared';
import { formatPct, type PricingResult } from '../../utils/pricing';

/** True below the xl breakpoint (where the results column stacks under the
 *  inputs and the total scrolls out of view). */
function useBelowXl(): boolean {
  return useMediaQuery('(max-width: 1279px)');
}

/** Sticky bottom bar with the headline price, shown while the single-column
 *  layout would otherwise hide the total during input. */
export function CalculatorMobileSummary({ result, currency }: { result: PricingResult; currency: string }) {
  const { t } = useTranslation();
  const below = useBelowXl();
  if (!below) return null;
  return (
    <>
      {/* In-flow spacer so the fixed bar never covers the last card */}
      <div className="h-14" aria-hidden="true" />
      {/* pr-20 keeps the price clear of the global bug-report FAB (fixed bottom-4 right-4, ~64px zone) */}
      <div className="fixed bottom-0 inset-x-0 z-40 flex items-center justify-between gap-4 border-t border-bambu-dark-tertiary bg-bambu-dark-secondary/95 pl-4 pr-20 py-2.5 backdrop-blur">
        <span className="text-sm text-bambu-gray truncate">
          {t('calculator.totalTTC')}
          {result.quantity > 1 ? ` · ${t('calculator.perUnit')}` : ''}
        </span>
        <span className="flex items-center gap-3">
          <span className="text-xs px-2 py-0.5 rounded-full bg-bambu-green/10 text-bambu-green tabular-nums">
            {formatPct(result.margin_pct)}
          </span>
          <Money currency={currency} value={result.total_ttc} className="text-lg font-bold text-bambu-green" />
        </span>
      </div>
    </>
  );
}
