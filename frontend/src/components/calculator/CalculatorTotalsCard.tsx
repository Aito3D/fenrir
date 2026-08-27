import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Copy, Crosshair, FileText, Receipt } from 'lucide-react';
import { Card, CardContent, CardHeader } from '../Card';
import { Button } from '../Button';
import { Collapsible } from '../Collapsible';
import { NumberField } from '../NumberField';
import { focusRingCls } from '../formStyles';
import { useToast } from '../../contexts/ToastContext';
import { useSettledValue } from '../../hooks/useSettledValue';
import { CostSplitBar, Money, PrinterComparisonChips, SegmentLegend, type PrinterComparisonEntry, type Segment } from './shared';
import { formatMoney, formatPct, targetPriceProfit, type PricingResult } from '../../utils/pricing';
import { getCurrencySymbol } from '../../utils/currency';
import { num } from '../../hooks/useCalculatorState';

export function CalculatorTotalsCard({
  result,
  segments,
  currency,
  easy,
  summaryText,
  taxPct,
  targetPrice,
  onTargetPriceChange,
  targetPriceError,
  printerComparison = [],
  selectedPrinterId = null,
  onSelectPrinter,
  onOpenQuote,
}: {
  result: PricingResult;
  segments: Segment[];
  currency: string;
  easy: boolean;
  summaryText: string;
  taxPct: number;
  targetPrice: string;
  onTargetPriceChange: (v: string) => void;
  targetPriceError?: string;
  printerComparison?: PrinterComparisonEntry[];
  selectedPrinterId?: number | null;
  onSelectPrinter?: (id: number) => void;
  onOpenQuote?: () => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const quantity = result.quantity;
  const target = targetPriceProfit(num(targetPrice), taxPct, result.total_cost);

  // Screen-reader echo of the headline price: announce once per typing pause
  // (settled value), never per keystroke.
  const settledTotal = useSettledValue(result.total_ttc, 600);

  const copySummary = async () => {
    try {
      await navigator.clipboard.writeText(summaryText);
      showToast(t('calculator.summaryCopied'));
    } catch {
      // Clipboard unavailable (insecure context, permissions).
      showToast(t('calculator.summaryCopyFailed'), 'error');
    }
  };

  return (
    <Card className="animate-calc-rise">
      <CardHeader className="flex items-center justify-between">
        <h2 className="font-semibold text-white flex items-center gap-2">
          <Receipt className="w-4 h-4 text-bambu-gray" />
          {t('calculator.totals')}
        </h2>
        <span className="flex items-center gap-2">
          <span className="text-sm text-bambu-gray flex items-center gap-2">
            {t('calculator.marginPct')}:
            <span className="text-xs px-2 py-0.5 rounded-full bg-bambu-green/10 text-bambu-green tabular-nums">
              {formatPct(result.margin_pct)}
            </span>
          </span>
          <Button variant="ghost" size="sm" onClick={copySummary} aria-label={t('calculator.copySummary')} title={t('calculator.copySummary')}>
            <Copy className="w-4 h-4" />
          </Button>
          {onOpenQuote && (
            <Button variant="ghost" size="sm" onClick={onOpenQuote} aria-label={t('calculator.quote.open')} title={t('calculator.quote.open')}>
              <FileText className="w-4 h-4" />
            </Button>
          )}
        </span>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-lg bg-bambu-green/5 border border-bambu-green/20 px-4 py-3 space-y-2">
          {onSelectPrinter && (
            <PrinterComparisonChips
              comparison={printerComparison}
              selectedPrinterId={selectedPrinterId}
              baseTotal={result.total_ttc}
              currency={currency}
              onSelect={onSelectPrinter}
            />
          )}
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="text-sm text-bambu-gray">
                {t('calculator.totalTTC')}
                {quantity > 1 ? ` · ${t('calculator.perUnit')}` : ''}
              </div>
              <Money countUp currency={currency} value={result.total_ttc} className="text-4xl font-bold tracking-tight text-bambu-green" />
              <p className="sr-only" role="status">
                {t('calculator.totalTTC')}: {formatMoney(settledTotal, currency)}
              </p>
            </div>
            {quantity > 1 && (
              <div className="text-right">
                <div className="text-sm text-bambu-gray">{t('calculator.forQuantity', { count: quantity })}</div>
                <Money countUp currency={currency} value={result.total_ttc_qty} className="text-xl font-semibold text-white" />
              </div>
            )}
          </div>
        </div>
        {easy && (
          <Link
            to="/calculator?tab=settings"
            className={`block w-fit text-xs text-bambu-gray underline decoration-bambu-gray/40 underline-offset-2 hover:text-white transition-colors rounded ${focusRingCls}`}
          >
            {t('calculator.easyAssumptions')}
          </Link>
        )}
        <div className={`grid gap-x-6 gap-y-2 text-sm ${easy ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-3'}`}>
          <div className="flex justify-between gap-2">
            <span className="text-bambu-gray">{t('calculator.totalHT')}</span>
            <Money currency={currency} value={result.total_ht} className="text-white" />
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-bambu-gray">{t('calculator.marge')}</span>
            <Money currency={currency} value={result.marge} className="text-white" />
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-bambu-gray">{t('calculator.machineCost')}</span>
            <Money currency={currency} value={result.machine_cost} className="text-white" />
          </div>
          {!easy && (
            <>
              <div className="flex justify-between gap-2">
                <span className="text-bambu-gray">{t('calculator.machineCostSafety')}</span>
                <Money currency={currency} value={result.machine_cost_safety} className="text-white" />
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-bambu-gray">{t('calculator.costsSoFar')}</span>
                <Money currency={currency} value={result.total_cost} className="text-white" />
              </div>
              {quantity > 1 && (
                <div className="flex justify-between gap-2">
                  <span className="text-bambu-gray">
                    {t('calculator.totalHT')} ×{quantity}
                  </span>
                  <Money currency={currency} value={result.total_ht_qty} className="text-white" />
                </div>
              )}
            </>
          )}
        </div>
        {easy && (
          <div className="space-y-2">
            <CostSplitBar segments={segments} total={result.total_cost} currency={currency} />
            <SegmentLegend segments={segments} total={result.total_cost} />
          </div>
        )}
        <Collapsible
          animated
          className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-3 py-2.5"
          summary={
            <span className="text-sm text-white flex items-center gap-2">
              <Crosshair className="w-4 h-4 text-bambu-gray" aria-hidden="true" />
              {t('calculator.targetPrice')}
            </span>
          }
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
            <NumberField
              id="calc-target-price"
              label={t('calculator.targetPriceLabel')}
              unit={getCurrencySymbol(currency)}
              value={targetPrice}
              onChange={onTargetPriceChange}
              error={targetPriceError}
              placeholder="0"
            />
            {target && (
              <div className="flex justify-between gap-2 text-sm pb-2.5">
                <span className="text-bambu-gray">{t('calculator.targetPriceProfit')}</span>
                <span className={target.profit < 0 ? 'text-status-error' : 'text-status-ok'}>
                  <Money currency={currency} value={target.profit} />{' '}
                  <span className="tabular-nums">({formatPct(target.margin, 1)})</span>
                </span>
              </div>
            )}
          </div>
        </Collapsible>
      </CardContent>
    </Card>
  );
}
