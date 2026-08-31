// Live preview of the two margin curves (utils/pricing.ts), drawn from the
// UNSAVED pricing form so the operator sees the shape they are about to
// save. Rendered beside the margin fields in CalculatorSettingsPanel.

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CartesianGrid, Line, LineChart, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CURVE_DEFAULTS, formatMoney, qtyFactor, sizeMargin, unitMultiplier, type PricingDefaults } from '../../utils/pricing';
import { prefersReducedMotion } from '../../utils/motion';
import { parsedExample, qtyDomainMax, roundK, roundKQ, sizeDomainMax } from './curveGeometry';
import { FormulaPopover } from './FormulaPopover';
import { DragHandle } from './DragHandle';
import { NumberField } from '../NumberField';
import { getCurrencySymbol } from '../../utils/currency';
import { TOOLTIP } from './shared';

const SIZE_STRIP = [0.25, 0.5, 1, 2, 4, 10]; // × K
const QTY_STRIP = [1, 2, 5, 10, 20, 50, 100];

const AXIS = { fontSize: 11 } as const;
const GRID = 'var(--color-bambu-dark-tertiary)';
const INK = 'var(--color-bambu-gray)';

function Curve({
  title,
  children,
  strip,
  formula,
}: {
  title: string;
  children: ReactNode;
  strip: ReactNode;
  formula?: { label: string; lines: string[] };
}) {
  return (
    <div className="relative">
      <div className="mb-2 flex items-center gap-1.5">
        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-bambu-gray">{title}</span>
        {formula && <FormulaPopover label={formula.label} lines={formula.lines} />}
      </div>
      <div className="rounded-lg bg-bambu-dark/60 pt-3 pr-2">{children}</div>
      {strip}
    </div>
  );
}

export function MarginCurvePreview({
  d,
  currency,
  example,
  onExampleChange,
  seededFromJob,
  onDragK,
  onDragKQ,
  readOnly,
}: {
  d: PricingDefaults;
  currency: string;
  example: { unitCost: string; quantity: string };
  onExampleChange: (patch: Partial<{ unitCost: string; quantity: string }>) => void;
  seededFromJob?: boolean;
  onDragK?: (k: number) => void;
  onDragKQ?: (kq: number) => void;
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const animMs = prefersReducedMotion() ? 0 : 350;
  const k = d.margin_k ?? CURVE_DEFAULTS.margin_k;
  const kq = d.qty_k ?? CURVE_DEFAULTS.qty_k;
  const ex = parsedExample(example);

  // The size chart's domain scales with K (sizeDomainMax = k * 10), which is
  // exactly the value the K drag handle writes back — left live during a
  // drag, every pointermove would re-derive K from a domain that K itself
  // just moved, compounding K by ~10x per move (see T-006). Freezing K at
  // the value it had when the drag started, for the domain calc only, keeps
  // the handle's min/max stable for the whole gesture; it snaps back to
  // tracking the live (typed or post-drop) K once the drag ends.
  const [kDragAnchor, setKDragAnchor] = useState<number | null>(null);

  // Math.max(1, …) — K = 0 would otherwise collapse the size domain to 0.
  const sizeMax = Math.max(1, sizeDomainMax(kDragAnchor ?? k, ex?.unitCost));
  // T-049: unlike the size domain, the KQ handle needs no drag anchor — see
  // qtyDomainMax's own doc comment for why the additive kq relationship it
  // uses can't runaway the way the multiplicative sizeDomainMax(k * 10) can.
  const qtyMax = qtyDomainMax(ex?.quantity, kq);

  const sizeData = useMemo(() => {
    return Array.from({ length: 81 }, (_, i) => {
      const u = (sizeMax * i) / 80;
      return { u, m: sizeMargin(u, d) };
    });
  }, [d, sizeMax]);
  const qtyData = useMemo(() => {
    // Sample count is capped independently of the domain so an example
    // quantity in the millions doesn't build a million-point chart.
    const points = Math.min(200, Math.ceil(qtyMax));
    const step = (qtyMax - 1) / (points - 1);
    return Array.from({ length: points }, (_, i) => {
      const q = 1 + i * step;
      return { q, f: qtyFactor(q, d) };
    });
  }, [d, qtyMax]);

  // The fixed ladder plus the model's own reference quantity (KQ + 1 — the
  // point the ReferenceLine marks, where the discount is halfway to Q_MIN),
  // inserted in sorted position and deduped.
  const midQty = kq + 1;
  const qtyStrip = useMemo(() => Array.from(new Set([...QTY_STRIP, midQty])).sort((a, b) => a - b), [midQty]);

  const mMin = d.margin_min_mult ?? CURVE_DEFAULTS.margin_min_mult;
  const mMax = d.margin_max_mult ?? CURVE_DEFAULTS.margin_max_mult;
  const qMin = d.qty_min_factor ?? CURVE_DEFAULTS.qty_min_factor;
  const sizeTitle = t('calculator.marginCurvePreviewSize');
  const qtyTitle = t('calculator.marginCurvePreviewQty');
  const sizeLines = [
    t('calculator.formulaSizeGeneric'),
    t('calculator.formulaSizeSubst', { mMin: mMin.toFixed(2), delta: (mMax - mMin).toFixed(2), k: formatMoney(k, currency, false) }),
    ...(ex ? [t('calculator.formulaAt', { x: formatMoney(ex.unitCost, currency), y: `×${sizeMargin(ex.unitCost, d).toFixed(3)}` })] : []),
  ];
  const qtyLines = [
    t('calculator.formulaQtyGeneric'),
    t('calculator.formulaQtySubst', { qMin: qMin.toFixed(2), delta: (1 - qMin).toFixed(2), kq, kqMinus1: kq - 1 }),
    ...(ex ? [t('calculator.formulaAt', { x: `q = ${ex.quantity}`, y: qtyFactor(ex.quantity, d).toFixed(3) })] : []),
  ];

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-bambu-gray mb-2">{t('calculator.exampleTitle')}</div>
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            id="calc-curve-example-cost"
            label={t('calculator.exampleUnitCost', { currency: getCurrencySymbol(currency) })}
            value={example.unitCost}
            onChange={(v) => onExampleChange({ unitCost: v })}
            min="0"
            max="1000000000"
          />
          <NumberField
            id="calc-curve-example-qty"
            label={t('calculator.exampleQuantity')}
            value={example.quantity}
            onChange={(v) => onExampleChange({ quantity: v })}
            min="1"
            step="1"
            max="1000000"
          />
        </div>
        {ex && (
          <p className="mt-2 text-xs text-bambu-gray-light tabular-nums">
            {t('calculator.exampleReadout', {
              size: sizeMargin(ex.unitCost, d).toFixed(3),
              qty: qtyFactor(ex.quantity, d).toFixed(3),
              total: unitMultiplier(ex.unitCost, ex.quantity, d).toFixed(3),
            })}
          </p>
        )}
        {seededFromJob && <p className="text-[11px] text-bambu-gray">{t('calculator.exampleFromCalculator')}</p>}
      </div>

      <Curve
        title={sizeTitle}
        formula={{ label: `${t('calculator.formulaShow')} — ${sizeTitle}`, lines: sizeLines }}
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
              domain={[0, sizeMax]}
              tickFormatter={(v: number) => formatMoney(v, currency, false)}
              tick={AXIS}
              stroke={INK}
              tickLine={false}
            />
            <YAxis
              domain={[mMin - 0.1, mMax + 0.1]}
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
            <ReferenceLine x={k} stroke="var(--color-bambu-green)" strokeDasharray="2 3" style={{ pointerEvents: 'none' }} />
            {onDragK && (
              <DragHandle
                value={k}
                min={0}
                max={sizeMax}
                onChange={onDragK}
                round={roundK}
                label={t('calculator.dragK')}
                readOnly={readOnly}
                onDragStart={() => setKDragAnchor(k)}
                onDragEnd={() => setKDragAnchor(null)}
              />
            )}
            <Line type="monotone" dataKey="m" name={t('calculator.sizeMarginGroup')} stroke="var(--viz-1)" dot={false} strokeWidth={2} animationDuration={animMs} animationEasing="ease-out" />
            {ex && <ReferenceDot x={ex.unitCost} y={sizeMargin(ex.unitCost, d)} r={5} fill="var(--color-bambu-green)" stroke="#fff" strokeWidth={1.5} />}
          </LineChart>
        </ResponsiveContainer>
      </Curve>

      <Curve
        title={qtyTitle}
        formula={{ label: `${t('calculator.formulaShow')} — ${qtyTitle}`, lines: qtyLines }}
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
            <XAxis dataKey="q" type="number" domain={[1, qtyMax]} tick={AXIS} stroke={INK} tickLine={false} />
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
            <ReferenceLine x={midQty} stroke="var(--color-bambu-green)" strokeDasharray="2 3" style={{ pointerEvents: 'none' }} />
            {onDragKQ && (
              <DragHandle
                value={midQty}
                ariaValue={kq}
                min={1}
                max={qtyMax}
                onChange={(v) => onDragKQ(Math.max(1, v - 1))}
                round={roundKQ}
                label={t('calculator.dragKQ')}
                readOnly={readOnly}
              />
            )}
            <Line type="monotone" dataKey="f" name={t('calculator.curveQtyFactor')} stroke="var(--viz-2)" dot={false} strokeWidth={2} animationDuration={animMs} animationEasing="ease-out" />
            {ex && <ReferenceDot x={ex.quantity} y={qtyFactor(ex.quantity, d)} r={5} fill="var(--color-bambu-green)" stroke="#fff" strokeWidth={1.5} />}
          </LineChart>
        </ResponsiveContainer>
      </Curve>
    </div>
  );
}
