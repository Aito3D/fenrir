import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3 } from 'lucide-react';
import { DeltaBadge } from '../../stats/DeltaBadge';
import type { StatDelta } from '../../stats/deltas';

/** The statistics screens have no cards: blocks sit on the page ground under
 *  a small heading, rows are separated by hairlines, and the only surfaces
 *  are the strip's cells. These are the pieces every screen is built from. */

/** A block's title, with an optional right-hand side (a legend, a caption). */
export function BlockHeading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h4 className="text-[13px] font-medium text-bambu-gray-light">{children}</h4>
      {aside}
    </div>
  );
}

/** A screen's finding: the lead clause in white, the rest muted. One
 *  sentence the operator would say out loud; the chart below is its proof. */
export function Finding({ lead, rest, testId }: { lead: string; rest?: string | null; testId?: string }) {
  return (
    <h3
      data-testid={testId}
      className="max-w-[40ch] text-[24px] font-semibold leading-[1.22] tracking-[-0.02em] text-white text-balance"
    >
      {lead}
      {rest ? <span className="font-medium text-bambu-gray-light"> {rest}</span> : null}
    </h3>
  );
}

/** Chart left, facts right; stacked on a narrow screen. */
export function Split({ children }: { children: ReactNode }) {
  return <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)] lg:gap-10">{children}</div>;
}

export function Block({ children, testId, className = '' }: { children: ReactNode; testId?: string; className?: string }) {
  return (
    <div data-testid={testId} className={`grid gap-2.5 min-w-0 ${className}`}>
      {children}
    </div>
  );
}

export interface FactRow {
  label: ReactNode;
  value: ReactNode;
  /** A muted addition after the value — the money behind a count, a share. */
  note?: ReactNode;
  /** `alert` paints the value red (money owed), `warn` amber (a quote left waiting). */
  tone?: 'alert' | 'warn';
  testId?: string;
}

/** Label left, value right, hairlines between rows. */
export function Facts({ rows, testId }: { rows: FactRow[]; testId?: string }) {
  return (
    <dl data-testid={testId} className="grid">
      {rows.map((row, i) => (
        <div
          key={i}
          data-testid={row.testId}
          className={`flex items-baseline justify-between gap-4 py-2 text-[13px] ${i === 0 ? '' : 'border-t border-bambu-dark-tertiary/70'}`}
        >
          <dt className="text-bambu-gray-light">{row.label}</dt>
          <dd
            className={`text-right font-medium tabular-nums ${
              row.tone === 'alert' ? 'text-status-error' : row.tone === 'warn' ? 'text-amber-400' : 'text-white'
            }`}
          >
            {row.value}
            {row.note !== undefined && row.note !== null && (
              <span className="ml-1.5 text-xs font-normal text-bambu-gray">{row.note}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export interface BarSegment {
  /** Relative length inside the row's bar. */
  weight: number;
  /** A complete Tailwind background class (stage colours) … */
  cls?: string;
  /** … or a literal colour (series colours). */
  color?: string;
  title?: string;
  segment?: string;
}

/** One figure. `swatch` draws a 3px dash in the series colour before the
 *  value so the figure and its bars read as the same thing. */
export function Fig({
  swatch,
  value,
  label,
  delta,
  deltaTitle,
  tone,
  small,
}: {
  swatch?: string;
  value: string;
  label: string;
  delta?: StatDelta | null;
  deltaTitle?: string;
  tone?: 'alert';
  small?: boolean;
}) {
  return (
    <div className="grid gap-0.5 animate-rise">
      <span className="flex items-baseline gap-2">
        {swatch && <span aria-hidden="true" className="inline-block h-[3px] w-2.5 self-center rounded-full" style={{ backgroundColor: swatch }} />}
        {/* Keyed on the value so the tick replays when the range changes. */}
        <span
          key={value}
          className={`${small ? 'text-xl' : 'text-[26px]'} font-semibold leading-none tracking-[-0.02em] animate-value-tick ${tone === 'alert' ? 'text-status-error' : 'text-white'}`}
        >
          {value}
        </span>
        {delta !== undefined && <DeltaBadge delta={delta} title={deltaTitle} />}
      </span>
      <span className="text-[12.5px] text-bambu-gray-light">{label}</span>
    </div>
  );
}

/** Horizontal bar rows: label, a bar scaled to `scale` (0..1) of the track
 *  and split into segments, a value on the right. An `<ol>` so a test can
 *  count the rows. */
export function HBars({
  rows,
  testId,
  labelWidth = 'w-36 sm:w-44',
}: {
  rows: Array<{ key: string; label: ReactNode; scale: number; segments: BarSegment[]; value: ReactNode; title?: string }>;
  testId?: string;
  labelWidth?: string;
}) {
  return (
    <ol data-testid={testId} className="grid gap-2 text-xs">
      {rows.map((row) => (
        <li key={row.key} className="flex items-center gap-3" title={row.title}>
          <span className={`${labelWidth} shrink-0 truncate text-bambu-gray-light`}>{row.label}</span>
          <span className="min-w-0 flex-1" aria-hidden="true">
            <span className="flex h-2 gap-[2px]" style={{ width: `${Math.max(0, Math.min(1, row.scale)) * 100}%` }}>
              {row.segments
                .filter((s) => s.weight > 0)
                .map((s, i) => (
                  <span
                    key={i}
                    data-segment={s.segment}
                    title={s.title}
                    className={`block h-full min-w-[3px] rounded-[2px] ${s.cls ?? ''}`}
                    style={{ flexGrow: s.weight, backgroundColor: s.color }}
                  />
                ))}
            </span>
          </span>
          <span className="w-28 shrink-0 text-right text-bambu-gray-light tabular-nums">{row.value}</span>
        </li>
      ))}
    </ol>
  );
}

/** The typical journey: one bar split by the median days per stage, the
 *  figures under each part. Stages with no sample are left out. */
export function Journey({ stages }: { stages: Array<{ id: string; label: string; days: number; cls: string }> }) {
  const shown = stages.filter((s) => s.days > 0);
  return (
    <div className="grid gap-1.5">
      <div className="flex h-3.5 gap-[2px]" aria-hidden="true">
        {shown.map((s) => (
          <span key={s.id} className={`block h-full min-w-[3px] rounded-[2px] ${s.cls}`} style={{ flexGrow: s.days }} />
        ))}
      </div>
      <ul className="flex text-[11.5px] text-bambu-gray-light">
        {shown.map((s) => (
          <li key={s.id} className="min-w-0 truncate pr-2" style={{ flexGrow: s.days, flexBasis: 0 }}>
            <span className="font-medium text-white">{s.days.toFixed(1)}</span> {s.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** « As of today » — a snapshot block saying so, so the range selector is
 *  not read as applying to it. Extra text (« · oldest 45 d ») follows. */
export function AsOfToday({ extra }: { extra?: string }) {
  const { t } = useTranslation();
  return (
    <p className="text-[11px] text-bambu-gray">
      {t('aito.stats.asOfToday')}
      {extra ? ` · ${extra}` : ''}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
      <BarChart3 className="w-8 h-8 text-bambu-gray" aria-hidden="true" />
      <p className="text-sm text-bambu-gray">{children}</p>
    </div>
  );
}

export function Legend({ color, cls, line, children }: { color?: string; cls?: string; line?: boolean; children: ReactNode }) {
  return (
    <li className="inline-flex items-center gap-1.5">
      {line ? (
        <span aria-hidden="true" className="inline-block h-0 w-4 border-t-2 border-dashed" style={{ borderColor: color }} />
      ) : (
        <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${cls ?? ''}`} style={{ backgroundColor: color }} />
      )}
      {children}
    </li>
  );
}

export function LegendList({ children }: { children: ReactNode }) {
  return <ul className="flex flex-wrap justify-end gap-x-3.5 gap-y-1 text-[11.5px] text-bambu-gray-light">{children}</ul>;
}
