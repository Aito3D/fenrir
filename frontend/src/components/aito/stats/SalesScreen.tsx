import { useTranslation } from 'react-i18next';
import type { AitoStats } from '../../../api/client';
import { DecisionsChart } from './DecisionsChart';
import { DECISION } from './palette';
import { Facts, Finding, HBars, Panel, Split } from './primitives';
import { useStatsFormat } from './useStatsFormat';

/** Sales: the win rate and what was lost, the decisions over time, and the
 *  win rate by ticket size. */
export function SalesScreen({ data }: { data: AitoStats }) {
  const { t } = useTranslation();
  const { money } = useStatsFormat();
  const sent = data.conversion.sent;
  const accepted = data.conversion.accepted;
  const declined = data.conversion.declined;
  const done = data.throughput?.done ?? 0;
  const decided = accepted.count + declined.count;
  const rate = decided > 0 ? Math.round((accepted.count / decided) * 100) : null;
  const bands = data.size_bands ?? [];
  const busiest = Math.max(0, ...bands.map((b) => b.accepted + b.declined));
  const waiting = (data.quote_age ?? []).find((b) => b.bucket === '15+');

  // The lost clause: when the largest tickets are where the declines are,
  // say so; otherwise just the count and the money.
  let rest: string | null = null;
  if (decided > 0 && declined.count > 0) {
    const top = bands[bands.length - 1];
    const mostDeclined = Math.max(...bands.map((b) => b.declined));
    if (bands.length > 1 && top.declined > 0 && top.declined === mostDeclined) {
      rest = t('aito.stats.finding.salesLostBig', {
        lost: top.declined,
        decided: top.accepted + top.declined,
        min: money(top.min),
        total: money(declined.total),
      });
    } else {
      rest = t('aito.stats.finding.salesLost', { count: declined.count, total: money(declined.total) });
    }
  }
  const lead = rate === null ? t('aito.stats.finding.salesNone') : t('aito.stats.finding.salesWin', { pct: rate });

  return (
    <div className="grid gap-3">
      <Finding testId="aito-stats-finding" lead={lead} rest={rest} />
      <Split>
        <DecisionsChart daily={data.daily ?? []} />
        <div className="grid gap-3">
          <Panel title={t('aito.stats.funnel')}>
          <Facts
            testId="aito-stats-funnel"
            rows={[
              { label: t('aito.stats.sent'), value: sent.count, note: sent.count > 0 ? money(sent.total) : undefined },
              { label: t('aito.stats.accepted'), value: accepted.count, note: accepted.count > 0 ? money(accepted.total) : undefined },
              { label: t('aito.stats.declined'), value: declined.count, note: declined.count > 0 ? money(declined.total) : undefined },
              {
                label: t('aito.stats.completed'),
                value: done,
                note: accepted.count > 0 ? t('aito.stats.ofAccepted', { pct: Math.round((done / accepted.count) * 100) }) : undefined,
              },
              {
                testId: 'aito-stats-quote-age',
                label: (
                  <>
                    {t('aito.stats.facts.waiting15')} <span className="text-xs text-bambu-gray">{t('aito.stats.facts.today')}</span>
                  </>
                ),
                value: waiting?.count ?? 0,
                note: waiting && waiting.count > 0 ? money(waiting.total) : undefined,
                tone: waiting && waiting.count > 0 ? 'warn' : undefined,
              },
            ]}
          />
          </Panel>
          <Panel title={t('aito.stats.winRate')}>
            {bands.length > 0 ? (
              <HBars
                testId="aito-stats-win-rate"
                labelWidth="w-36 sm:w-40"
                rows={bands.map((band, i) => {
                  const n = band.accepted + band.declined;
                  const pct = band.rate === null ? 0 : Math.round(band.rate * 100);
                  return {
                    key: String(i),
                    label: `${money(band.min)} – ${money(band.max)}`,
                    scale: busiest > 0 ? n / busiest : 0,
                    segments: [
                      { weight: band.accepted, color: DECISION.accepted, segment: 'accepted' },
                      { weight: band.declined, color: DECISION.declined, segment: 'declined' },
                    ],
                    value: (
                      <>
                        <span className="font-medium text-white">{pct}%</span> · {t('aito.stats.decisions', { count: n })}
                      </>
                    ),
                  };
                })}
              />
            ) : (
              <p data-testid="aito-stats-win-rate" className="rounded-lg bg-bambu-dark px-3 py-2.5 text-xs text-bambu-gray">
                {t('aito.stats.winRateEmpty')}
              </p>
            )}
          </Panel>
        </div>
      </Split>
    </div>
  );
}
