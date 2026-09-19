import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { api, type AitoStats } from '../../api/client';
import { Button } from '../Button';
import type { DateRange } from '../stats/timeframe';
import { ActivityChart } from './stats/ActivityChart';
import { Briefing, type BriefInput } from './stats/Briefing';
import { ClientsSection } from './stats/ClientsSection';
import { FiguresBand } from './stats/FiguresBand';
import { MoneySection } from './stats/MoneySection';
import { Empty } from './stats/primitives';
import { SalesSection } from './stats/SalesSection';
import { SectionAccordion } from './stats/SectionAccordion';
import { TimeSection } from './stats/TimeSection';
import { AITO_SERVICE_LABEL_KEYS } from './services';
import { useStatsFormat } from './stats/useStatsFormat';

/** The board's statistics view as a morning brief: a sentence that answers
 *  « what do I do today » and the three lists behind it (from the board
 *  list, instantly), then the period's figures, the activity chart and the
 *  four analysis sections folded shut. Same endpoint as the Stats page's
 *  pipeline widget, sliced by the timeframe selector the PAGE renders in its
 *  toolbar and passes down as `range`. */
export function StatsView({ range, brief = null }: { range: DateRange; brief?: BriefInput | null }) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ['aitoStats', range.dateFrom, range.dateTo],
    queryFn: () => api.getAitoStats(range),
    // A range change keeps the previous numbers on screen, dimmed, until the
    // new ones land in place — never a spinner and a re-layout. The figure
    // ticks then mark what changed.
    placeholderData: keepPreviousData,
  });
  const data = query.data;
  const holding = query.isPlaceholderData || (query.isFetching && data !== undefined);

  return (
    <section data-testid="aito-stats-view" className="animate-rise space-y-6">
      <Briefing brief={brief} stats={data?.throughput ? data : undefined} />

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

function Body({ data }: { data: AitoStats }) {
  const { t } = useTranslation();
  const { money, days } = useStatsFormat();
  const tp = data.throughput!;
  const decided = data.conversion.accepted.count + data.conversion.declined.count;
  const topService = [...(data.services ?? [])].sort((a, b) => b.revenue - a.revenue)[0];
  const revenue = (data.services ?? []).reduce((s, r) => s + r.revenue, 0);

  const teasers = {
    sales:
      decided > 0
        ? t('aito.stats.teaser.sales', {
            pct: Math.round((data.conversion.accepted.count / decided) * 100),
            lost: data.conversion.declined.count,
            total: money(data.conversion.declined.total),
          })
        : t('aito.stats.noDecisions'),
    time: t('aito.stats.teaser.time', { lead: days(tp.lead_days), moves: data.rework?.moves ?? 0 }),
    money:
      topService && revenue > 0
        ? t('aito.stats.teaser.money', {
            accepted: money(data.conversion.accepted.total),
            outstanding: money(data.invoicing.outstanding_balance),
            service: t(AITO_SERVICE_LABEL_KEYS[topService.service] ?? topService.service),
            pct: Math.round((topService.revenue / revenue) * 100),
          })
        : t('aito.stats.teaser.moneyPlain', {
            accepted: money(data.conversion.accepted.total),
            outstanding: money(data.invoicing.outstanding_balance),
          }),
    clients: t('aito.stats.teaser.clients', { new: data.clients?.new ?? 0, returning: data.clients?.returning ?? 0 }),
  };

  return (
    <>
      <FiguresBand data={data} />

      <div className="animate-rise-lg" style={{ '--enter-delay': '160ms' } as React.CSSProperties}>
        <ActivityChart daily={data.daily ?? []} />
      </div>

      <div className="space-y-2 animate-rise-lg" style={{ '--enter-delay': '240ms' } as React.CSSProperties}>
        <SectionAccordion id="aito-stats-sales" heading={t('aito.stats.sales')} teaser={teasers.sales}>
          <SalesSection data={data} />
        </SectionAccordion>
        <SectionAccordion id="aito-stats-time" heading={t('aito.stats.time')} teaser={teasers.time}>
          <TimeSection data={data} />
        </SectionAccordion>
        <SectionAccordion id="aito-stats-money" heading={t('aito.stats.money')} teaser={teasers.money}>
          <MoneySection data={data} />
        </SectionAccordion>
        <SectionAccordion id="aito-stats-clients" heading={t('aito.stats.clients')} teaser={teasers.clients}>
          <ClientsSection data={data} />
        </SectionAccordion>
      </div>
    </>
  );
}
