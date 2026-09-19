import { useTranslation } from 'react-i18next';
import type { AitoStats } from '../../../api/client';
import { DeltaBadge } from '../../stats/DeltaBadge';
import { computeDelta } from '../../stats/deltas';
import { PanelCard } from '../PanelCard';
import { SERIES } from './palette';
import { useStatsFormat } from './useStatsFormat';

/** The period's five figures on one line between two hairlines — the six
 *  tiles this replaces each claimed a card of their own and made the page
 *  read as a wall. Values are keyed so the tick replays when the range
 *  changes; the figures cascade on first paint at the child cadence. */
export function FiguresBand({ data }: { data: AitoStats }) {
  const { t } = useTranslation();
  const { money, days } = useStatsFormat();
  const tp = data.throughput!;
  const prev = data.previous ?? null;
  const decided = data.conversion.accepted.count + data.conversion.declined.count;
  const rate = decided > 0 ? Math.round((data.conversion.accepted.count / decided) * 100) : null;
  const previousTitle = (value: string | number | null | undefined) =>
    value === null || value === undefined ? undefined : t('aito.stats.vsPrevious', { value });

  return (
    <div data-testid="aito-stats-band">
      <PanelCard title={t('aito.stats.thisPeriod')}>
      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3 stagger-children">
        <Figure
          swatch={SERIES.created}
          value={String(tp.created)}
          label={t('aito.stats.added')}
          delta={computeDelta(tp.created, prev?.created, 'more-is-good')}
          deltaTitle={previousTitle(prev?.created)}
        />
        <Figure
          swatch={SERIES.accepted}
          value={String(tp.accepted)}
          label={rate === null ? t('aito.stats.accepted') : `${t('aito.stats.accepted')} · ${t('aito.stats.acceptanceRate', { pct: rate })}`}
          delta={computeDelta(tp.accepted, prev?.accepted, 'more-is-good')}
          deltaTitle={previousTitle(prev?.accepted)}
        />
        <Figure
          swatch={SERIES.done}
          value={String(tp.done)}
          label={t('aito.stats.completed')}
          delta={computeDelta(tp.done, prev?.done, 'more-is-good')}
          deltaTitle={previousTitle(prev?.done)}
        />
        <Figure
          value={days(tp.lead_days)}
          label={t('aito.stats.leadTime')}
          delta={computeDelta(tp.lead_days ?? 0, prev?.lead_days, 'more-is-bad')}
          deltaTitle={previousTitle(prev?.lead_days == null ? null : days(prev.lead_days))}
        />
        <Figure value={money(data.conversion.accepted.total)} label={t('aito.stats.quoted')} />
      </div>
      </PanelCard>
    </div>
  );
}

function Figure({
  swatch,
  value,
  label,
  delta,
  deltaTitle,
}: {
  swatch?: string;
  value: string;
  label: string;
  delta?: ReturnType<typeof computeDelta>;
  deltaTitle?: string;
}) {
  return (
    <div className="grid gap-px animate-rise">
      <span className="flex items-baseline gap-2">
        {swatch && <span aria-hidden="true" className="inline-block h-0.5 w-2.5 self-center rounded-full" style={{ backgroundColor: swatch }} />}
        <span key={value} className="text-xl font-semibold tracking-[-0.01em] text-white animate-value-tick">
          {value}
        </span>
        {delta !== undefined && <DeltaBadge delta={delta} title={deltaTitle} />}
      </span>
      <span className="text-xs text-bambu-gray-light">{label}</span>
    </div>
  );
}
