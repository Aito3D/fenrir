import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3 } from 'lucide-react';
import { DeltaBadge } from '../../stats/DeltaBadge';
import type { StatDelta } from '../../stats/deltas';

/** A block's title inside a card — the detail panel's eyebrow, so the
 *  statistics read as more of the same panel. */
export function Heading({ children }: { children: ReactNode }) {
  return <h3 className="text-xs uppercase tracking-wide text-bambu-gray">{children}</h3>;
}

/** A section's title: Sales, Time, Money, Clients. */
export function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="text-base font-semibold text-white">{children}</h2>;
}

/** The card every block sits in: the panel's own card shell (`PanelCard`),
 *  on the darker surface because these live inside a folded section that is
 *  itself a panel card. */
export function Card({ testId, children, className = '' }: { testId?: string; children: ReactNode; className?: string }) {
  return (
    <section
      data-testid={testId}
      className={`rounded-[.6rem] border border-bambu-dark-tertiary bg-bambu-dark p-3 space-y-3 min-w-0 ${className}`}
    >
      {children}
    </section>
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

export function Legend({ color, line, children }: { color: string; line?: boolean; children: ReactNode }) {
  return (
    <li className="inline-flex items-center gap-1.5">
      {line ? (
        <span aria-hidden="true" className="inline-block h-0 w-4 border-t-2 border-dashed" style={{ borderColor: color }} />
      ) : (
        <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      )}
      {children}
    </li>
  );
}

/** One figure. `accent` draws a 2px hairline in the series colour under the
 *  label so the tile and its bars read as the same thing; text stays in text
 *  tokens. Values are proportional figures on purpose — tabular digits look
 *  loose at this size and nothing here aligns vertically. */
export function Tile({
  label,
  value,
  sub,
  delta,
  deltaTitle,
  accent,
  small,
  tone,
  enter,
}: {
  label: string;
  value: string;
  sub?: string;
  delta?: StatDelta | null;
  deltaTitle?: string;
  accent?: string;
  small?: boolean;
  /** `alert` paints the value red: an overdue count, a 15+ day quote. */
  tone?: 'alert';
  /** Plays the page's `rise` on mount; put the tiles in a `stagger-children`
   *  grid and they cascade at the 50ms child cadence. */
  enter?: boolean;
}) {
  return (
    <div className={`rounded-[.6rem] border border-bambu-dark-tertiary bg-bambu-dark px-3 py-2.5 min-w-0 ${enter ? 'animate-rise' : ''}`}>
      <div className="flex items-center gap-2 text-xs text-bambu-gray">
        {accent && <span aria-hidden="true" className="inline-block h-0.5 w-3 rounded-full" style={{ backgroundColor: accent }} />}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-0.5 flex items-baseline gap-2">
        {/* Keyed on the value so the tick replays when the range changes —
            the same idiom as the board's in-production count. */}
        <span
          key={value}
          className={`${small ? 'text-base' : 'text-2xl'} font-semibold truncate animate-value-tick ${tone === 'alert' ? 'text-status-error' : 'text-white'}`}
        >
          {value}
        </span>
        {delta !== undefined && <DeltaBadge delta={delta} title={deltaTitle} />}
      </div>
      {sub && <div className="text-xs text-bambu-gray-light truncate">{sub}</div>}
    </div>
  );
}

/** A smaller tile for tiles that live INSIDE a card (the card already
 *  carries the secondary surface, so these sit on the darker one). */
export function InnerTile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'alert' }) {
  return (
    <div className="rounded-lg bg-bambu-dark-secondary px-3 py-2 min-w-0">
      <div className="text-[11px] text-bambu-gray truncate">{label}</div>
      <div className={`text-lg font-semibold ${tone === 'alert' ? 'text-status-error' : 'text-white'}`}>{value}</div>
      <div className="text-[11px] text-bambu-gray-light">{sub ?? ' '}</div>
    </div>
  );
}

export function Step({
  label,
  value,
  rate,
  note,
  accent,
}: {
  label: string;
  value: number;
  rate?: string;
  /** A muted fourth line — the funnel's « lost » figure under Accepted. */
  note?: string;
  accent?: string;
}) {
  return (
    <li className="flex-1 min-w-0 rounded-lg bg-bambu-dark-secondary px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] text-bambu-gray truncate">
        {accent && <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: accent }} />}
        {label}
      </div>
      <div className="text-lg font-semibold text-white">{value}</div>
      <div className="text-[11px] text-bambu-gray-light">{rate ?? ' '}</div>
      {note && <div className="text-[11px] text-bambu-gray">{note}</div>}
    </li>
  );
}
