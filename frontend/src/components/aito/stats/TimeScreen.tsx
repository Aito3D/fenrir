import { useTranslation } from 'react-i18next';
import type { AitoStats } from '../../../api/client';
import { COLUMNS } from '../columns';
import { Block, BlockHeading, Empty, Facts, Finding, HBars, Journey, Legend, LegendList, Split } from './primitives';
import { useStatsFormat } from './useStatsFormat';

/** Time: how long a project takes, which stage is slow, one stacked bar per
 *  completed card so the outlier shows, and how often work went backwards. */
export function TimeScreen({ data }: { data: AitoStats }) {
  const { t } = useTranslation();
  const { days } = useStatsFormat();
  const tp = data.throughput;
  const meta = (column: string) => COLUMNS.find((c) => c.id === column);
  const label = (column: string) => {
    const m = meta(column);
    return m ? t(m.labelKey) : column;
  };

  const stages = data.stage_days.map((s) => ({ id: s.column, label: label(s.column), days: s.median_days ?? 0, cls: meta(s.column)?.dot ?? 'bg-bambu-gray' }));
  const slowest = stages.reduce<(typeof stages)[number] | null>((best, s) => (s.days > 0 && (best === null || s.days > best.days) ? s : best), null);
  const rework = data.rework;

  const cards = (data.stage_time ?? [])
    .map((row) => ({ ...row, total: Object.values(row.stages).reduce((s, v) => s + v, 0) }))
    .sort((a, b) => b.total - a.total);
  const longest = cards[0]?.total ?? 0;

  const clauses: string[] = [];
  if (slowest) clauses.push(t('aito.stats.finding.timeSlow', { stage: slowest.label, days: days(slowest.days) }));
  if (rework && rework.moves > 0) {
    clauses.push(t('aito.stats.finding.timeRework', { count: rework.moves, cards: t('aito.stats.facts.cards', { count: rework.cards }) }));
  }
  const lead = tp?.lead_days == null ? t('aito.stats.finding.timeNone') : t('aito.stats.finding.timeLead', { days: days(tp.lead_days) });

  return (
    <div className="grid gap-6">
      <Finding testId="aito-stats-finding" lead={lead} rest={clauses.length ? clauses.join(' ') : null} />
      <Split>
        <Block testId="aito-stats-stage-time">
          <BlockHeading
            aside={
              <LegendList>
                {COLUMNS.map((c) => (
                  <Legend key={c.id} cls={c.dot}>
                    {t(c.labelKey)}
                  </Legend>
                ))}
              </LegendList>
            }
          >
            {t('aito.stats.stageTime')}
          </BlockHeading>
          {cards.length > 0 ? (
            <HBars
              testId="aito-stats-stage-rows"
              labelWidth="w-40 sm:w-56"
              rows={cards.map((row) => ({
                key: String(row.project_id),
                title: `${row.client_name ?? ''} · ${row.description}`,
                label: (
                  <>
                    {row.client_name ? <span className="text-white">{row.client_name}</span> : null}
                    {row.client_name ? ' · ' : ''}
                    {row.description}
                  </>
                ),
                scale: longest > 0 ? row.total / longest : 0,
                segments: COLUMNS.map((c) => ({
                  weight: row.stages[c.id] ?? 0,
                  cls: c.dot,
                  title: `${t(c.labelKey)} · ${days(row.stages[c.id])}`,
                })),
                value: <span className="font-medium text-white">{days(row.total)}</span>,
              }))}
            />
          ) : (
            <Empty>{t('aito.stats.empty')}</Empty>
          )}
        </Block>
        <div className="grid gap-6">
          <Block testId="aito-stats-flow">
            <BlockHeading>{t('aito.stats.flow')}</BlockHeading>
            {stages.some((s) => s.days > 0) ? <Journey stages={stages} /> : <p className="text-xs text-bambu-gray">{t('aito.stats.empty')}</p>}
          </Block>
          <Facts
            rows={[
              {
                label: t('aito.stats.leadTime'),
                value: days(tp?.lead_days),
                note: tp?.lead_days_median == null ? undefined : t('aito.stats.median', { days: tp.lead_days_median.toFixed(1) }),
              },
              { label: t('aito.stats.productionTime'), value: days(tp?.production_days) },
              {
                testId: 'aito-stats-rework',
                label: t('aito.stats.reworkMoves'),
                value: rework ? rework.moves : '—',
                note:
                  rework && rework.share !== null && rework.moves > 0
                    ? t('aito.stats.reworkShare', { cards: rework.cards, pct: Math.round(rework.share * 100) })
                    : undefined,
                tone: rework && rework.moves > 0 ? 'alert' : undefined,
              },
            ]}
          />
        </div>
      </Split>
    </div>
  );
}
