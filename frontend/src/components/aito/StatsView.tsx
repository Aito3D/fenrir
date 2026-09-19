import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { api, type AitoStats } from '../../api/client';
import { Button } from '../Button';
import type { DateRange } from '../stats/timeframe';
import { computeDelta } from '../stats/deltas';
import { ActivityChart } from './stats/ActivityChart';
import { ClientsSection } from './stats/ClientsSection';
import { JumpStrip } from './stats/JumpStrip';
import { MoneySection } from './stats/MoneySection';
import { SERIES } from './stats/palette';
import { Empty, SectionHeading, Tile } from './stats/primitives';
import { SalesSection } from './stats/SalesSection';
import { TimeSection } from './stats/TimeSection';
import { useStatsFormat } from './stats/useStatsFormat';

/** The board's statistics view: how much work comes in, how much goes out,
 *  and how long it takes — the questions the board itself cannot answer
 *  because it only shows now. Same endpoint as the Stats page's pipeline
 *  widget, sliced by the same timeframe selector — which the PAGE renders in
 *  its toolbar (where Import and New project sit for the board) and passes
 *  down as `range`. The overview (tiles + activity) sits on top; four
 *  sections follow under a sticky jump strip. */
export function StatsView({ range }: { range: DateRange }) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ['aitoStats', range.dateFrom, range.dateTo],
    queryFn: () => api.getAitoStats(range),
    // A range change keeps the previous numbers on screen, dimmed, until the
    // new ones land in place — never a spinner and a re-layout. The KPI ticks
    // then mark what changed.
    placeholderData: keepPreviousData,
  });
  const data = query.data;
  const holding = query.isPlaceholderData || (query.isFetching && data !== undefined);

  return (
    <section data-testid="aito-stats-view" className="animate-rise space-y-6">
      <p className="text-sm text-bambu-gray-light">
        {data?.throughput
          ? t('aito.stats.caption', {
              active: data.throughput.active,
              done: data.board.find((b) => b.column === 'done')?.count ?? 0,
            })
          : ' '}
      </p>

      {query.isPending ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-8 h-8 text-bambu-gray animate-spin" />
        </div>
      ) : query.isError || !data ? (
        <div className="text-center py-12">
          <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
          <p className="text-white font-medium">{t('common.errorLoading')}</p>
          <Button variant="secondary" onClick={() => query.refetch()} className="mt-4 mx-auto">
            {t('common.retry')}
          </Button>
        </div>
      ) : !data.throughput ? (
        <Empty>{t('aito.stats.empty')}</Empty>
      ) : (
        <div
          aria-busy={holding || undefined}
          data-testid="aito-stats-body"
          className={`space-y-6 transition-opacity duration-150 ease-(--ease-signature) motion-reduce:transition-none ${holding ? 'opacity-60' : 'opacity-100'}`}
        >
          <Body data={data} />
        </div>
      )}
    </section>
  );
}

const SECTION_IDS = ['sales', 'time', 'money', 'clients'] as const;

function Body({ data }: { data: AitoStats }) {
  const { t } = useTranslation();
  const { days } = useStatsFormat();
  const tp = data.throughput!;
  const prev = data.previous ?? null;
  const previousTitle = (value: number | string | null | undefined) =>
    value === null || value === undefined ? undefined : t('aito.stats.vsPrevious', { value });
  const sections = SECTION_IDS.map((id) => ({ id: `aito-stats-${id}`, label: t(`aito.stats.${id}`) }));

  return (
    <>
      {/* Two-level entrance, the page's idiom: the tiles cascade at the 50ms
          child cadence, then the chart and each section land as parents on
          the 80ms slots, so the eye is led down the page once. Nothing below
          waits on a scroll. */}
      <div data-testid="aito-stats-kpis" className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6 stagger-children">
        <Tile
          enter
          label={t('aito.stats.added')}
          value={String(tp.created)}
          accent={SERIES.created}
          delta={computeDelta(tp.created, prev?.created, 'more-is-good')}
          deltaTitle={previousTitle(prev?.created)}
        />
        <Tile
          enter
          label={t('aito.stats.accepted')}
          value={String(tp.accepted)}
          accent={SERIES.accepted}
          delta={computeDelta(tp.accepted, prev?.accepted, 'more-is-good')}
          deltaTitle={previousTitle(prev?.accepted)}
        />
        <Tile
          enter
          label={t('aito.stats.completed')}
          value={String(tp.done)}
          accent={SERIES.done}
          delta={computeDelta(tp.done, prev?.done, 'more-is-good')}
          deltaTitle={previousTitle(prev?.done)}
        />
        <Tile
          enter
          label={t('aito.stats.perDay')}
          value={tp.per_day === null ? '—' : tp.per_day.toFixed(tp.per_day < 1 ? 2 : 1)}
          sub={tp.per_day === null ? undefined : t('aito.stats.perWeek', { count: Math.round(tp.per_day * 7 * 10) / 10 })}
        />
        <Tile
          enter
          label={t('aito.stats.leadTime')}
          value={days(tp.lead_days)}
          sub={tp.lead_days_median === null ? undefined : t('aito.stats.median', { days: tp.lead_days_median.toFixed(1) })}
          delta={computeDelta(tp.lead_days ?? 0, prev?.lead_days, 'more-is-bad')}
          deltaTitle={previousTitle(prev?.lead_days === null || prev?.lead_days === undefined ? null : days(prev.lead_days))}
        />
        <Tile enter label={t('aito.stats.productionTime')} value={days(tp.production_days)} />
      </div>

      <div className="animate-rise-lg" style={{ '--enter-delay': '160ms' } as CSSProperties}>
        <ActivityChart daily={data.daily ?? []} />
      </div>

      <JumpStrip sections={sections} />

      {SECTION_IDS.map((id, i) => (
        <section
          key={id}
          id={`aito-stats-${id}`}
          data-testid={`aito-stats-section-${id}`}
          className="scroll-mt-14 space-y-3 animate-rise-lg"
          style={{ '--enter-delay': `${240 + i * 80}ms` } as CSSProperties}
        >
          <SectionHeading>{t(`aito.stats.${id}`)}</SectionHeading>
          {id === 'sales' && <SalesSection data={data} />}
          {id === 'time' && <TimeSection data={data} />}
          {id === 'money' && <MoneySection data={data} />}
          {id === 'clients' && <ClientsSection data={data} />}
        </section>
      ))}
    </>
  );
}
