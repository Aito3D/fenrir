import { useTranslation } from 'react-i18next';
import type { AitoStats } from '../../../api/client';
import { SERIES } from './palette';
import { AsOfToday, Card, Empty, Heading, InnerTile, Step } from './primitives';
import { useStatsFormat } from './useStatsFormat';

/** Sales: the funnel with what was lost, the quotes still waiting for an
 *  answer by age, and the win rate by ticket size. */
export function SalesSection({ data }: { data: AitoStats }) {
  const { t } = useTranslation();
  const { money } = useStatsFormat();
  const tp = data.throughput;
  const sent = data.conversion.sent.count;
  const accepted = tp?.accepted ?? data.conversion.accepted.count;
  const done = tp?.done ?? 0;
  const pctOfSent = sent > 0 ? Math.round((accepted / sent) * 100) : null;
  const pctOfAccepted = accepted > 0 ? Math.round((done / accepted) * 100) : null;
  const lost = data.conversion.declined;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card testId="aito-stats-funnel">
        <Heading>{t('aito.stats.funnel')}</Heading>
        <ol className="flex items-stretch gap-2">
          <Step label={t('aito.stats.sent')} value={sent} />
          <Step
            label={t('aito.stats.accepted')}
            value={accepted}
            rate={pctOfSent === null ? undefined : t('aito.stats.ofSent', { pct: pctOfSent })}
            note={lost.count > 0 ? t('aito.stats.lost', { count: lost.count, total: money(lost.total) }) : undefined}
            accent={SERIES.accepted}
          />
          <Step
            label={t('aito.stats.completed')}
            value={done}
            rate={pctOfAccepted === null ? undefined : t('aito.stats.ofAccepted', { pct: pctOfAccepted })}
            accent={SERIES.done}
          />
        </ol>
      </Card>

      <Card testId="aito-stats-quote-age">
        <div className="flex items-baseline justify-between gap-3">
          <Heading>{t('aito.stats.quoteAge')}</Heading>
          <AsOfToday />
        </div>
        {data.quote_age ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {data.quote_age.map((row) => (
              <InnerTile
                key={row.bucket}
                label={t('aito.stats.ageDays', { range: row.bucket.replace('-', '–') })}
                value={String(row.count)}
                sub={row.count > 0 ? money(row.total) : undefined}
                tone={row.bucket === '15+' && row.count > 0 ? 'alert' : undefined}
              />
            ))}
          </div>
        ) : (
          <Empty>{t('aito.stats.empty')}</Empty>
        )}
      </Card>

      <Card testId="aito-stats-win-rate" className="lg:col-span-2">
        <Heading>{t('aito.stats.winRate')}</Heading>
        {data.size_bands && data.size_bands.length > 0 ? (
          <ol className="space-y-2">
            {data.size_bands.map((band, i) => {
              const n = band.accepted + band.declined;
              const pct = band.rate === null ? 0 : Math.round(band.rate * 100);
              return (
                <li key={i} className="flex items-center gap-3 text-xs">
                  <span className="w-40 shrink-0 truncate text-bambu-gray-light sm:w-52">
                    {money(band.min)} – {money(band.max)}
                  </span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-bambu-dark" aria-hidden="true">
                    <span className="block h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: SERIES.accepted }} />
                  </span>
                  <span className="w-28 shrink-0 text-right text-bambu-gray-light">
                    <span className="font-medium text-white">{pct}%</span> · {t('aito.stats.decisions', { count: n })}
                  </span>
                </li>
              );
            })}
          </ol>
        ) : (
          <Empty>{t('aito.stats.winRateEmpty')}</Empty>
        )}
      </Card>
    </div>
  );
}
