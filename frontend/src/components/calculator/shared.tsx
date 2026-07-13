// Shared building blocks for the calculator page components: money display
// with a settled-value tick animation, the cost-split bar + legend, and the
// table class strings used by the discount and bulk tables.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatMoney, formatPct } from '../../utils/pricing';

export const thCls =
  'px-3 py-2 text-right text-[11px] uppercase tracking-wide font-medium text-bambu-gray whitespace-nowrap';
export const tdCls = 'px-3 py-2 text-right text-sm text-white tabular-nums whitespace-nowrap';
// Rows use the solid .calc-table-row backgrounds (index.css) so the sticky
// cell can inherit them without scrolled columns bleeding through.
export const stickyTdCls = 'sticky left-0 z-10 bg-inherit';
export const rowCls = 'calc-table-row border-b border-bambu-dark-tertiary/50 transition-colors';

/** The value once it has stopped changing for `delay` ms. */
function useSettledValue<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(handle);
  }, [value, delay]);
  return settled;
}

export function Money({ value, currency, className = '' }: { value: number; currency: string; className?: string }) {
  // The displayed amount always tracks `value` live; the remount key uses the
  // SETTLED value so the tick animation plays once after typing pauses
  // instead of flickering on every keystroke.
  const settled = useSettledValue(value, 250);
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
