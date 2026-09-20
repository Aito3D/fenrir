import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { AitoStats } from '../../../api/client';
import { computeDelta } from '../../stats/deltas';
import { localDateKey, parseLocalDateKey } from '../../../utils/date';
import { ActivityChart, WEEKLY_ABOVE_DAYS } from './ActivityChart';
import { SERIES } from './palette';
import { Fig, Finding, Split } from './primitives';
import { useStatsFormat } from './useStatsFormat';

/** Overview: what came in, what was accepted, what went out, and when. */
export function OverviewScreen({ data }: { data: AitoStats }) {
  const { t, i18n } = useTranslation();
  const { money, days } = useStatsFormat();
  const tp = data.throughput!;
  const prev = data.previous ?? null;
  const decided = data.conversion.accepted.count + data.conversion.declined.count;
  const rate = decided > 0 ? Math.round((data.conversion.accepted.count / decided) * 100) : null;
  const previousTitle = (value: string | number | null | undefined) =>
    value === null || value === undefined ? undefined : t('aito.stats.vsPrevious', { value });

  const peak = useMemo(() => {
    const daily = data.daily ?? [];
    if (daily.length === 0) return null;
    const fmt = new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'long' });
    if (daily.length > WEEKLY_ABOVE_DAYS) {
      const weeks = new Map<string, number>();
      for (const d of daily) {
        const date = parseLocalDateKey(d.day);
        const start = new Date(date);
        start.setDate(date.getDate() - ((date.getDay() + 6) % 7));
        const key = localDateKey(start);
        weeks.set(key, (weeks.get(key) ?? 0) + d.created + d.accepted + d.done);
      }
      let best: [string, number] | null = null;
      for (const entry of weeks) if (entry[1] > 0 && (best === null || entry[1] > best[1])) best = entry;
      return best ? t('aito.stats.finding.overviewPeakWeek', { date: fmt.format(parseLocalDateKey(best[0])) }) : null;
    }
    let best: (typeof daily)[number] | null = null;
    for (const d of daily) {
      const n = d.created + d.accepted + d.done;
      if (n > 0 && (best === null || n > best.created + best.accepted + best.done)) best = d;
    }
    return best ? t('aito.stats.finding.overviewPeakDay', { date: fmt.format(parseLocalDateKey(best.day)) }) : null;
  }, [data.daily, i18n.language, t]);

  const lead = t('aito.stats.finding.overview', {
    in: t('aito.stats.finding.overviewIn', { count: tp.created }),
    accepted: t('aito.stats.finding.overviewAccepted', { count: tp.accepted }),
    done: t('aito.stats.finding.overviewDone', { count: tp.done }),
  });

  return (
    <div className="grid gap-6">
      <Finding testId="aito-stats-finding" lead={lead} rest={peak} />
      <Split>
        <ActivityChart daily={data.daily ?? []} />
        <div data-testid="aito-stats-band" className="grid gap-4 stagger-children">
          <Fig
            swatch={SERIES.created}
            value={String(tp.created)}
            label={tp.per_day ? `${t('aito.stats.added')} · ${t('aito.stats.facts.perDay', { count: tp.per_day })}` : t('aito.stats.added')}
            delta={computeDelta(tp.created, prev?.created, 'more-is-good')}
            deltaTitle={previousTitle(prev?.created)}
          />
          <Fig
            swatch={SERIES.accepted}
            value={String(tp.accepted)}
            label={rate === null ? t('aito.stats.accepted') : `${t('aito.stats.accepted')} · ${t('aito.stats.acceptanceRate', { pct: rate })}`}
            delta={computeDelta(tp.accepted, prev?.accepted, 'more-is-good')}
            deltaTitle={previousTitle(prev?.accepted)}
          />
          <Fig
            swatch={SERIES.done}
            value={String(tp.done)}
            label={t('aito.stats.completed')}
            delta={computeDelta(tp.done, prev?.done, 'more-is-good')}
            deltaTitle={previousTitle(prev?.done)}
          />
          <Fig
            value={days(tp.lead_days)}
            label={
              tp.lead_days_median == null
                ? t('aito.stats.leadTime')
                : `${t('aito.stats.leadTime')} · ${t('aito.stats.median', { days: tp.lead_days_median.toFixed(1) })}`
            }
            delta={computeDelta(tp.lead_days ?? 0, prev?.lead_days, 'more-is-bad')}
            deltaTitle={previousTitle(prev?.lead_days == null ? null : days(prev.lead_days))}
          />
          <Fig value={money(data.conversion.accepted.total)} label={t('aito.stats.quoted')} />
        </div>
      </Split>
    </div>
  );
}
