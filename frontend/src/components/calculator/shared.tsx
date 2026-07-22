// Shared building blocks for the calculator page components: money display
// with a settled-value tick animation, the cost-split bar + legend, and the
// table class strings used by the discount and bulk tables.

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { focusRingCls } from '../formStyles';
import { formatMoney, formatPct } from '../../utils/pricing';
import { computeDelta, type StatDelta } from '../stats/deltas';
import { useSettledValue } from '../../hooks/useSettledValue';

export const thCls =
  'px-3 py-2 text-right text-[11px] uppercase tracking-wide font-medium text-bambu-gray whitespace-nowrap';
export const tdCls = 'px-3 py-2 text-right text-sm text-white tabular-nums whitespace-nowrap';
// Rows use the solid .calc-table-row backgrounds (index.css) so the sticky
// cell can inherit them without scrolled columns bleeding through.
export const stickyTdCls = 'sticky left-0 z-10 bg-inherit';
export const rowCls = 'calc-table-row border-b border-bambu-dark-tertiary/50 transition-colors';


/** Numeric interpolation toward `target` (~250ms ease-out). Inactive (and
 *  snapped to the target) when disabled or reduced motion is preferred. */
function useCountUp(target: number, enabled: boolean): number {
  const [display, setDisplay] = useState(target);
  const displayRef = useRef(target);
  useEffect(() => {
    const reduceMotion =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!enabled || reduceMotion || !Number.isFinite(target)) {
      displayRef.current = target;
      setDisplay(target);
      return;
    }
    const from = displayRef.current;
    if (from === target) return;
    const start = performance.now();
    const duration = 250;
    let raf = 0;
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const next = progress < 1 ? from + (target - from) * eased : target;
      displayRef.current = next;
      setDisplay(next);
      if (progress < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, enabled]);
  return enabled ? display : target;
}

export function Money({
  value,
  currency,
  className = '',
  countUp = false,
}: {
  value: number;
  currency: string;
  className?: string;
  /** Animate numerically toward the settled value — headline totals only. */
  countUp?: boolean;
}) {
  // The displayed amount always tracks `value` live; the remount key uses the
  // SETTLED value so the tick animation plays once after typing pauses
  // instead of flickering on every keystroke. In count-up mode the number
  // itself interpolates to the settled value instead of remount-ticking.
  const settled = useSettledValue(value, 250);
  const counted = useCountUp(settled, countUp);
  if (countUp) {
    return <span className={`tabular-nums ${className}`}>{formatMoney(counted, currency)}</span>;
  }
  return (
    <span key={settled} className={`tabular-nums animate-value-tick ${className}`}>
      {formatMoney(value, currency)}
    </span>
  );
}

export interface Segment {
  key: string;
  label: string;
  value: number;
  color: string;
}

export function CostSplitBar({ segments, total, currency }: { segments: Segment[]; total: number; currency: string }) {
  const { t } = useTranslation();
  if (total <= 0) return null;
  return (
    <div className="flex h-2.5 rounded-full overflow-hidden gap-[2px]" role="img" aria-label={t('calculator.costSplit')}>
      {segments.map((s) => (
        <div
          key={s.key}
          title={`${s.label}: ${formatMoney(s.value, currency)} (${formatPct(s.value / total, 1)})`}
          style={{ width: `${(s.value / total) * 100}%`, minWidth: 3, backgroundColor: s.color }}
          className="rounded-sm transition-all duration-300 hover:opacity-80"
        />
      ))}
    </div>
  );
}

export function SegmentLegend({ segments, total }: { segments: Segment[]; total?: number }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {segments.map((s) => (
        <span key={s.key} className="flex items-center gap-1.5 text-xs text-bambu-gray">
          <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: s.color }} />
          {s.label}
          {total !== undefined && total > 0 && (
            <>
              {' · '}
              <span className="tabular-nums">{formatPct(s.value / total, 1)}</span>
            </>
          )}
        </span>
      ))}
    </div>
  );
}

// ---- Per-printer price comparison chips -----------------------------------

export interface PrinterComparisonEntry {
  id: number;
  name: string;
  total: number;
}

// Same good/bad/neutral → theme-token mapping DeltaBadge uses; kept local
// because the chip label format differs (signed %, not arrows).
const DELTA_TONE_CLASS = {
  good: 'text-status-ok',
  bad: 'text-status-error',
  neutral: 'text-bambu-gray',
} as const;

/** "+12%" / "−3.4%" below 10%, "±0%" when flat. */
function signedDeltaLabel(delta: StatDelta): string {
  if (delta.direction === 'flat') return '±0%';
  const abs = Math.abs(delta.pct);
  return `${delta.pct > 0 ? '+' : '−'}${abs >= 10 ? Math.round(abs) : abs.toFixed(1)}%`;
}

/**
 * The same job priced on every other configured printer, so the operator sees
 * the machine cost delta at a glance. The selected printer is omitted (its
 * price IS the total shown right below); each chip shows that machine's price
 * plus the % delta vs the current selection — green when cheaper, red when
 * pricier. Clicking a chip re-prices with that printer.
 */
export function PrinterComparisonChips({
  comparison,
  selectedPrinterId,
  baseTotal,
  currency,
  onSelect,
}: {
  comparison: PrinterComparisonEntry[];
  selectedPrinterId: number | null;
  baseTotal: number;
  currency: string;
  onSelect: (id: number) => void;
}) {
  const { t } = useTranslation();
  const others = comparison.filter((p) => p.id !== selectedPrinterId);
  if (comparison.length < 2 || others.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('calculator.byPrinter')}>
      {others.map((p) => {
        // Cheaper is good, pricier is bad — the operator is picking a machine.
        const delta = computeDelta(p.total, baseTotal, 'more-is-bad');
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelect(p.id)}
            title={t('calculator.byPrinterHint', { name: p.name })}
            className={`inline-flex items-baseline gap-1.5 px-2 py-0.5 rounded-full border text-xs border-bambu-dark-tertiary hover:border-bambu-green/50 hover:bg-bambu-green/5 transition-[color,background-color,border-color,transform] duration-100 ease-out motion-safe:active:scale-95 ${focusRingCls}`}
          >
            <span className="text-bambu-gray truncate max-w-[9rem]">{p.name}</span>
            <Money currency={currency} value={p.total} className="text-white" />
            {delta && <span className={`tabular-nums ${DELTA_TONE_CLASS[delta.tone]}`}>{signedDeltaLabel(delta)}</span>}
          </button>
        );
      })}
    </div>
  );
}
