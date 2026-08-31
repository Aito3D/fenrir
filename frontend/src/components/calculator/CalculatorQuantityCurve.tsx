import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { TrendingDown } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardHeader } from '../Card';
import { rowCls, stickyTdCls, tdCls, thCls, TOOLTIP } from './shared';
import { formatMoney, type CurvePoint } from '../../utils/pricing';

/** Unit price versus quantity — the curve the margin model draws for this
 *  job. Points come from unitPriceCurve() in the page (full recompute per
 *  quantity). Replaces the former bulk-discount table. */
export function CalculatorQuantityCurve({ points, currency }: { points: CurvePoint[]; currency: string }) {
  const { t } = useTranslation();
  if (points.length === 0) return null;
  const current = points.find((p) => p.current);
  return (
    <Card className="animate-calc-rise" style={{ animationDelay: '150ms' }}>
      <CardHeader>
        <h2 className="font-semibold text-white flex items-center gap-2">
          <TrendingDown className="w-4 h-4 text-bambu-gray" />
          {t('calculator.curveTitle')}
        </h2>
        <p className="text-sm text-bambu-gray mt-1">{t('calculator.curveHint')}</p>
      </CardHeader>
      <CardContent className="!p-0">
        <div className="px-4 pt-4">
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="var(--color-bambu-dark-tertiary)" strokeDasharray="3 3" />
              <XAxis dataKey="quantity" type="number" scale="log" domain={['dataMin', 'dataMax']} ticks={points.map((p) => p.quantity)} tick={{ fontSize: 11 }} stroke="var(--color-bambu-gray)" />
              <YAxis tickFormatter={(v: number) => formatMoney(v, currency, false)} tick={{ fontSize: 11 }} width={64} stroke="var(--color-bambu-gray)" />
              <Tooltip
                {...TOOLTIP}
                formatter={(v: number | undefined) => formatMoney(Number(v ?? 0), currency)}
                labelFormatter={(q: ReactNode) => `${t('calculator.bulkQuantity')} ${Number(q ?? 0)}`}
              />
              <Line type="monotone" dataKey="unit_ttc" name={t('calculator.curveUnitPrice')} stroke="var(--viz-1)" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
              {current && <ReferenceDot x={current.quantity} y={current.unit_ttc} r={6} fill="var(--color-bambu-green)" stroke="none" />}
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="calc-table-row border-b border-bambu-dark-tertiary">
                <th className={`px-4 py-2 text-left text-[11px] uppercase tracking-wide font-medium text-bambu-gray ${stickyTdCls}`}>{t('calculator.bulkQuantity')}</th>
                <th className={thCls}>{t('calculator.curveUnitPrice')}</th>
                <th className={thCls}>{t('calculator.curveTaskPrice')}</th>
                <th className={thCls}>{t('calculator.curveQtyFactor')}</th>
                <th className={thCls}>{t('calculator.marge')}</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.quantity} className={`${rowCls} last:border-b-0 ${p.current ? 'bg-bambu-green/10' : ''}`} aria-current={p.current ? 'true' : undefined}>
                  <td className={`px-4 py-2 text-sm text-white font-medium tabular-nums ${stickyTdCls}`}>
                    {p.quantity}
                    {p.current && <span className="ml-2 text-[10px] uppercase text-bambu-green">{t('calculator.curveCurrent')}</span>}
                  </td>
                  <td className={tdCls}>
                    {formatMoney(p.unit_ttc, currency)}
                    {p.floor_applied && <span className="ml-1 text-bambu-gray" title={t('calculator.floorApplied')} aria-label={t('calculator.floorApplied')}>▲</span>}
                  </td>
                  <td className={tdCls}>{formatMoney(p.task_ttc, currency)}</td>
                  <td className={tdCls}>{p.qty_factor.toFixed(2)}</td>
                  <td className={tdCls}>{t('calculator.multiplier', { value: p.multiplier.toFixed(2) })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
