import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3 } from 'lucide-react';
import { DeltaBadge } from '../../stats/DeltaBadge';
import type { StatDelta } from '../../stats/deltas';

/** The statistics view speaks the app's panel language: every block is a
 *  `PanelCard` shell (the detail panel's own group), and every figure inside
 *  one sits on the darker ground as a card of its own. */

/** A block. Same shell and eyebrow as `PanelCard`, but the title may be a
 *  node — the strip's header is a date line, not an eyebrow. */
export function Panel({
  title,
  action,
  children,
  testId,
  className = '',
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <section
      data-testid={testId}
      className={`rounded-[.6rem] border border-bambu-dark-tertiary bg-bambu-dark-secondary p-3 min-w-0 ${className}`}
    >
      {(title !== undefined || action !== undefined) && (
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          {typeof title === 'string' ? <p className="text-xs uppercase tracking-wide text-bambu-gray">{title}</p> : title}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/** A screen's finding, in a panel of its own above the blocks it explains:
 *  the lead clause in white, the rest muted. One sentence the operator would
 *  say out loud; the cards below are its proof. */
export function Finding({ lead, rest, testId }: { lead: string; rest?: string | null; testId?: string }) {
  return (
    <Panel>
      <h3
        data-testid={testId}
        className="max-w-[46ch] text-[22px] font-semibold leading-[1.25] tracking-[-0.02em] text-white text-balance"
      >
        {lead}
        {rest ? <span className="font-medium text-bambu-gray-light"> {rest}</span> : null}
      </h3>
    </Panel>
  );
}

/** Chart left, facts right; stacked on a narrow screen. */
export function Split({ children }: { children: ReactNode }) {
  return <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">{children}</div>;
}

/** One figure as a card on the panel's darker ground. */
export function Tile({
  swatch,
  value,
  label,
  delta,
  deltaTitle,
  tone,
}: {
  swatch?: string;
  value: string;
  label: string;
  delta?: StatDelta | null;
  deltaTitle?: string;
  tone?: 'alert';
}) {
  return (
    <div className="rounded-lg bg-bambu-dark px-3 py-2.5 min-w-0 animate-rise">
      <div className="flex items-center gap-2 text-xs text-bambu-gray">
        {swatch && <span aria-hidden="true" className="inline-block h-[3px] w-3 shrink-0 rounded-full" style={{ backgroundColor: swatch }} />}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-0.5 flex items-baseline gap-2">
        {/* Keyed on the value so the tick replays when the range changes. */}
        <span
          key={value}
          className={`truncate text-2xl font-semibold tracking-[-0.02em] animate-value-tick ${tone === 'alert' ? 'text-status-error' : 'text-white'}`}
        >
          {value}
        </span>
        {delta !== undefined && <DeltaBadge delta={delta} title={deltaTitle} />}
      </div>
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

/** Label left, value right. Each row is a card on the darker ground, so a
 *  list of facts reads as the panel's contents rather than as ruled paper. */
export function Facts({ rows, testId }: { rows: FactRow[]; testId?: string }) {
  return (
    <dl data-testid={testId} className="grid gap-1.5">
      {rows.map((row, i) => (
        <div
          key={i}
          data-testid={row.testId}
          className="flex items-baseline justify-between gap-4 rounded-lg bg-bambu-dark px-3 py-2 text-[13px]"
        >
          <dt className="min-w-0 text-bambu-gray-light">{row.label}</dt>
          <dd
            className={`shrink-0 text-right font-medium tabular-nums ${
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

/** Horizontal bar rows on the panel's darker ground: label, a bar scaled to
 *  `scale` (0..1) of the track and split into segments, a value on the right. */
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
    <ol data-testid={testId} className="grid gap-1.5 text-xs">
      {rows.map((row) => (
        <li key={row.key} className="flex items-center gap-3 rounded-lg bg-bambu-dark px-3 py-2" title={row.title}>
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
    <div className="grid gap-1.5 rounded-lg bg-bambu-dark px-3 py-2.5">
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
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg bg-bambu-dark py-8 text-center">
      <BarChart3 className="w-7 h-7 text-bambu-gray" aria-hidden="true" />
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
