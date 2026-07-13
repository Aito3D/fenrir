import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Percent, TrendingDown } from 'lucide-react';
import { Card, CardContent, CardHeader } from '../Card';
import { rowCls, stickyTdCls, tdCls, thCls } from './shared';
import {
  breakEvenDiscount,
  DISCOUNT_COLUMNS,
  discountMatrix,
  formatMoney,
  formatPct,
  type PricingResult,
} from '../../utils/pricing';

export function CalculatorDiscountTable({
  result,
  currency,
  easy,
}: {
  result: PricingResult;
  currency: string;
  easy: boolean;
}) {
  const { t } = useTranslation();
  const matrix = useMemo(() => discountMatrix(result), [result]);
  const breakEven = breakEvenDiscount(result);
  // Columns discounted past break-even sell below cost — tint them.
  const belowCost = (discount: number) => breakEven !== null && discount > breakEven + 1e-9;
  const colCls = (discount: number) => (belowCost(discount) ? ' bg-status-error/5' : '');

  return (
    <Card className="animate-calc-rise" style={{ animationDelay: '200ms' }}>
      <CardHeader>
        <h2 className="font-semibold text-white flex items-center gap-2">
          <Percent className="w-4 h-4 text-bambu-gray" />
          {t('calculator.discountTitle')}
        </h2>
      </CardHeader>
      <CardContent className="!p-0">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="calc-table-row border-b border-bambu-dark-tertiary">
                <th className={`px-4 py-2 ${stickyTdCls}`}></th>
                {DISCOUNT_COLUMNS.map((d) => (
                  <th key={d} className={`${thCls}${belowCost(d) ? ' text-status-error' : ''}`}>
                    {formatPct(d, 0)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {!easy && (
                <>
                  <tr className={rowCls}>
                    <td className={`px-4 py-2 text-sm text-bambu-gray whitespace-nowrap ${stickyTdCls}`}>{t('calculator.discountMachine')}</td>
                    {matrix.map((c) => (
                      <td key={c.discount} className={tdCls + colCls(c.discount)}>{formatMoney(c.machine_cost, currency, false)}</td>
                    ))}
                  </tr>
                  <tr className={rowCls}>
                    <td className={`px-4 py-2 text-sm text-bambu-gray whitespace-nowrap ${stickyTdCls}`}>{t('calculator.discountSafety')}</td>
                    {matrix.map((c) => (
                      <td key={c.discount} className={tdCls + colCls(c.discount)}>{formatMoney(c.machine_cost_safety, currency, false)}</td>
                    ))}
                  </tr>
                </>
              )}
              <tr className="calc-table-row-accent border-b border-bambu-dark-tertiary/50">
                <td className={`px-4 py-2 text-sm text-white font-medium whitespace-nowrap ${stickyTdCls}`}>{t('calculator.discountPrice')}</td>
                {matrix.map((c) => (
                  <td key={c.discount} className={`${tdCls} font-semibold${colCls(c.discount)}`}>{formatMoney(c.price, currency, false)}</td>
                ))}
              </tr>
              {!easy && (
                <>
                  <tr className={rowCls}>
                    <td className={`px-4 py-2 text-sm text-bambu-gray whitespace-nowrap ${stickyTdCls}`}>{t('calculator.discountAmount')}</td>
                    {matrix.map((c) => (
                      <td key={c.discount} className={tdCls + colCls(c.discount)}>{formatMoney(c.discount_amount, currency, false)}</td>
                    ))}
                  </tr>
                  <tr className={rowCls}>
                    <td className={`px-4 py-2 text-sm text-bambu-gray whitespace-nowrap ${stickyTdCls}`}>{t('calculator.potentialProfit')}</td>
                    {matrix.map((c) => (
                      <td
                        key={c.discount}
                        className={`${tdCls} ${c.potential_profit < 0 ? 'text-status-error bg-status-error/10' : 'text-status-ok'}`}
                      >
                        {formatMoney(c.potential_profit, currency, false)}
                      </td>
                    ))}
                  </tr>
                  <tr className="calc-table-row">
                    <td className={`px-4 py-2 text-sm text-bambu-gray whitespace-nowrap ${stickyTdCls}`}>{t('calculator.marginPct')}</td>
                    {matrix.map((c) => (
                      <td
                        key={c.discount}
                        className={`${tdCls} ${c.potential_profit < 0 ? 'text-status-error' : 'text-bambu-gray-light'}${colCls(c.discount)}`}
                      >
                        {c.price_ht > 0 ? formatPct(c.potential_profit / c.price_ht, 1) : '—'}
                      </td>
                    ))}
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>
        {breakEven !== null && (
          <p className="flex items-center gap-1.5 px-4 py-2.5 text-xs text-bambu-gray border-t border-bambu-dark-tertiary/50">
            <TrendingDown className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
            {t('calculator.breakEvenDiscount', { pct: formatPct(breakEven, 1) })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
