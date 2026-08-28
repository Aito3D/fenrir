// Live preview of the two margin curves (utils/pricing.ts), drawn from the
// UNSAVED pricing form so the operator sees the shape they are about to
// save. Rendered beside the margin fields in CalculatorPricingPanel.

import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CURVE_DEFAULTS, formatMoney, qtyFactor, sizeMargin, type PricingDefaults } from '../../utils/pricing';
import { prefersReducedMotion } from '../../utils/motion';

const SIZE_STRIP = [0.25, 0.5, 1, 2, 4, 10]; // × K
const QTY_STRIP = [1, 2, 5, 10, 20, 50, 100];

const AXIS = { fontSize: 11 } as const;
const GRID = 'var(--color-bambu-dark-tertiary)';
const INK = 'var(--color-bambu-gray)';

// Dark tooltip matching the app's other charts (recharts defaults to white).
const TOOLTIP = {
  contentStyle: { background: 'var(--color-bambu-dark-secondary)', border: '1px solid var(--color-bambu-dark-tertiary)', borderRadius: 8, fontSize: 12, padding: '6px 10px' },
  labelStyle: { color: 'var(--color-bambu-gray)', marginBottom: 2 },
  itemStyle: { color: '#fff', padding: 0 },
  cursor: { stroke: 'var(--color-bambu-gray)', strokeWidth: 1 },
} as const;

function Curve({
  title,
  children,
  strip,
}: {
  title: string;
  children: ReactNode;
  strip: ReactNode;
}) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-bambu-gray mb-2">{title}</div>
      <div className="rounded-lg bg-bambu-dark/60 pt-3 pr-2">{children}</div>
      {strip}
    </div>
  );
}

export function MarginCurvePreview({ d, currency }: { d: PricingDefaults; currency: string }) {
  const { t } = useTranslation();
  const animMs = prefersReducedMotion() ? 0 : 350;
  const k = d.margin_k ?? CURVE_DEFAULTS.margin_k;
  const kq = d.qty_k ?? CURVE_DEFAULTS.qty_k;

  const sizeData = useMemo(() => {
    const maxU = k * 10;
    return Array.from({ length: 81 }, (_, i) => {
      const u = (maxU * i) / 80;
      return { u, m: sizeMargin(u, d) };
    });
  }, [d, k]);
  const qtyData = useMemo(() => Array.from({ length: 100 }, (_, i) => ({ q: i + 1, f: qtyFactor(i + 1, d) })), [d]);

  // The fixed ladder plus the model's own reference quantity (KQ + 1 — the
  // point the ReferenceLine marks, where the discount is halfway to Q_MIN),
  // inserted in sorted position and deduped.
  const midQty = kq + 1;
  const qtyStrip = useMemo(() => Array.from(new Set([...QTY_STRIP, midQty])).sort((a, b) => a - b), [midQty]);

  return (
    <div className="space-y-6">
      <Curve
        title={t('calculator.marginCurvePreviewSize')}
        strip={
          <dl className="mt-2 grid grid-cols-6 gap-1 text-center">
            {SIZE_STRIP.map((f) => {
              const isMid = f === 1;
              return (
                <div key={f}>
                  <dt className={`text-[11px] tabular-nums ${isMid ? 'text-bambu-green' : 'text-bambu-gray'}`}>
                    {formatMoney(k * f, currency, false)}
                  </dt>
                  <dd className="text-sm text-white tabular-nums">{`×${sizeMargin(k * f, d).toFixed(3)}`}</dd>
                </div>
              );
            })}
          </dl>
        }
      >
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={sizeData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="u"
              type="number"
              domain={[0, k * 10]}
              tickFormatter={(v: number) => formatMoney(v, currency, false)}
              tick={AXIS}
              stroke={INK}
              tickLine={false}
            />
            <YAxis
              domain={['auto', 'auto']}
              tickFormatter={(v: number) => `×${v.toFixed(2)}`}
              tick={AXIS}
              width={52}
              stroke={INK}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              {...TOOLTIP}
              formatter={(v: number | undefined) => `×${Number(v ?? 0).toFixed(3)}`}
              labelFormatter={(u: ReactNode) => formatMoney(Number(u ?? 0), currency)}
            />
            <ReferenceLine x={k} stroke="var(--color-bambu-green)" strokeDasharray="2 3" />
            <Line type="monotone" dataKey="m" name={t('calculator.sizeMarginGroup')} stroke="var(--viz-1)" dot={false} strokeWidth={2} animationDuration={animMs} animationEasing="ease-out" />
          </LineChart>
        </ResponsiveContainer>
      </Curve>

      <Curve
        title={t('calculator.marginCurvePreviewQty')}
        strip={
          <dl className="mt-2 grid gap-1 text-center" style={{ gridTemplateColumns: `repeat(${qtyStrip.length}, minmax(0, 1fr))` }}>
            {qtyStrip.map((q) => {
              const isMid = q === midQty;
              return (
                <div key={q}>
                  <dt className={`text-[11px] tabular-nums ${isMid ? 'text-bambu-green' : 'text-bambu-gray'}`}>{q}</dt>
                  <dd className="text-sm text-white tabular-nums">{qtyFactor(q, d).toFixed(2)}</dd>
                </div>
              );
            })}
          </dl>
        }
      >
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={qtyData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="q" type="number" domain={[1, 100]} tick={AXIS} stroke={INK} tickLine={false} />
            <YAxis
              domain={[0, 1]}
              tickFormatter={(v: number) => v.toFixed(2)}
              tick={AXIS}
              width={40}
              stroke={INK}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              {...TOOLTIP}
              formatter={(v: number | undefined) => Number(v ?? 0).toFixed(3)}
              labelFormatter={(q: ReactNode) => `${t('calculator.bulkQuantity')} ${q}`}
            />
            <ReferenceLine x={midQty} stroke="var(--color-bambu-green)" strokeDasharray="2 3" />
            <Line type="monotone" dataKey="f" name={t('calculator.curveQtyFactor')} stroke="var(--viz-2)" dot={false} strokeWidth={2} animationDuration={animMs} animationEasing="ease-out" />
          </LineChart>
        </ResponsiveContainer>
      </Curve>
    </div>
  );
}
