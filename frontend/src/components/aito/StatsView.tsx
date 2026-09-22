import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { api, ApiError, type AitoStats } from '../../api/client';
import { Button } from '../Button';
import { TimeframeSelector } from '../stats/TimeframeSelector';
import type { DateRange, TimeframeState } from '../stats/timeframe';
import { parseLocalDateKey } from '../../utils/date';
import { ClientsScreen } from './stats/ClientsScreen';
import { MoneyScreen } from './stats/MoneyScreen';
import { OverviewScreen } from './stats/OverviewScreen';
import { Empty } from './stats/primitives';
import { SalesScreen } from './stats/SalesScreen';
import { ScreenTabs } from './stats/ScreenTabs';
import { statsScreenId, statsTabId, useStatsScreen } from './stats/screens';
import { TimeScreen } from './stats/TimeScreen';
import { TodayStrip, type BriefInput } from './stats/TodayStrip';

/** The board's statistics view: today above the line, the period below it.
 *
 *  Above: the board drawn as a strip, with the to-dos hanging under the
 *  stage they belong to. It answers « what do I do today » and never moves
 *  when the range changes — it comes from the board list the page already
 *  holds, not from this call.
 *
 *  Below: the period, one question per screen behind a segmented control.
 *  Each screen leads with the finding in a sentence and proves it with one
 *  chart. The timeframe selector lives HERE rather than in the page toolbar:
 *  it only ever changes what sits under the tabs. */
export function StatsView({
  range,
  timeframe,
  onTimeframeChange,
  brief = null,
}: {
  range: DateRange;
  timeframe: TimeframeState;
  onTimeframeChange: (next: TimeframeState | ((prev: TimeframeState) => TimeframeState)) => void;
  brief?: BriefInput | null;
}) {
  const { t, i18n } = useTranslation();
  const [screen, selectScreen] = useStatsScreen();
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

  const fmt = new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'long' });
  const rangeLine =
    data?.date_from && data?.date_to
      ? t('aito.stats.range', { from: fmt.format(parseLocalDateKey(data.date_from)), to: fmt.format(parseLocalDateKey(data.date_to)) })
      : null;

  return (
    <section data-testid="aito-stats-view" className="animate-rise space-y-6 pb-6">
      <TodayStrip brief={brief} />

      <div className="space-y-4 border-t border-bambu-dark-tertiary pt-5">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="flex flex-wrap items-center gap-3">
            {/* Left-aligned: this trigger leads its row, so a right-hung
                menu would open leftwards off the content and under the
                sidebar. */}
            <TimeframeSelector timeframe={timeframe} onChange={onTimeframeChange} align="start" />
            {rangeLine && <span className="text-[12.5px] text-bambu-gray">{rangeLine}</span>}
          </div>
          <ScreenTabs selected={screen} onSelect={selectScreen} />
        </div>

        {query.isPending ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-8 h-8 text-bambu-gray animate-spin" />
          </div>
        ) : query.error instanceof ApiError && query.error.status === 422 ? (
          // The server's own message, not the generic one, and no Retry: a
          // 422 here means the range itself is what the request was refused
          // for (too many days, or outside the dates the backend accepts),
          // so retrying would only resend the same rejected range. The
          // timeframe selector above stays live — picking another range,
          // not a button in this panel, is the way out.
          <div className="text-center py-12">
            <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
            <p className="text-white font-medium">{query.error.message}</p>
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
            role="tabpanel"
            id={statsScreenId(screen)}
            aria-labelledby={statsTabId(screen)}
            tabIndex={-1}
            className={`transition-opacity duration-150 ease-(--ease-signature) motion-reduce:transition-none ${holding ? 'opacity-60' : 'opacity-100'}`}
          >
            {/* Keyed on the screen so the incoming one plays the page's rise
                rather than the charts morphing into each other. */}
            <div key={screen} className="animate-rise">
              <Screen screen={screen} data={data} />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function Screen({ screen, data }: { screen: ReturnType<typeof useStatsScreen>[0]; data: AitoStats }) {
  switch (screen) {
    case 'sales':
      return <SalesScreen data={data} />;
    case 'time':
      return <TimeScreen data={data} />;
    case 'money':
      return <MoneyScreen data={data} />;
    case 'clients':
      return <ClientsScreen data={data} />;
    default:
      return <OverviewScreen data={data} />;
  }
}

export type { BriefInput };
