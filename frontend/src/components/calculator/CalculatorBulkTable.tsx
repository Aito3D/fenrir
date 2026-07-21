import { useTranslation } from 'react-i18next';
import { Boxes } from 'lucide-react';
import { Card, CardContent, CardHeader } from '../Card';
import { rowCls, stickyTdCls, tdCls, thCls } from './shared';
import { BULK_DISCOUNTS, formatMoney, formatPct, type BulkRow } from '../../utils/pricing';

/** Bulk price table — rows are full recomputes per quantity (one-time costs
 *  amortized), produced by bulkPricing() in the page. */
export function CalculatorBulkTable({ rows, currency }: { rows: BulkRow[]; currency: string }) {
  const { t } = useTranslation();
  return (
    <Card className="animate-calc-rise" style={{ animationDelay: '150ms' }}>
      <CardHeader>
        <h2 className="font-semibold text-white flex items-center gap-2">
          <Boxes className="w-4 h-4 text-bambu-gray" />
          {t('calculator.bulkTitle')}
        </h2>
      </CardHeader>
      <CardContent className="!p-0 overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="calc-table-row border-b border-bambu-dark-tertiary">
              <th className={`px-4 py-2 text-left text-[11px] uppercase tracking-wide font-medium text-bambu-gray ${stickyTdCls}`}>{t('calculator.bulkQuantity')}</th>
              {BULK_DISCOUNTS.map((d) => (
                <th key={d} className={thCls}>{formatPct(d, 0)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.quantity} className={`${rowCls} last:border-b-0`}>
                <td className={`px-4 py-2 text-sm text-white font-medium tabular-nums ${stickyTdCls}`}>{row.quantity}</td>
                {row.prices.map((price, i) => (
                  <td key={BULK_DISCOUNTS[i]} className={tdCls}>{formatMoney(price, currency, false)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
