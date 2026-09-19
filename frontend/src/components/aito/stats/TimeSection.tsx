import { useTranslation } from 'react-i18next';
import type { AitoStats } from '../../../api/client';
import { COLUMNS } from '../columns';
import { Card, Empty, Heading, InnerTile } from './primitives';
import { useStatsFormat } from './useStatsFormat';

/** Time: median days per stage, one stacked bar per completed card so the
 *  outlier shows, and how often work went backwards. */
export function TimeSection({ data }: { data: AitoStats }) {
  const { t } = useTranslation();
  const { days } = useStatsFormat();
  const label = (column: string) => {
    const meta = COLUMNS.find((c) => c.id === column);
    return meta ? t(meta.labelKey) : column;
  };
  const dot = (column: string) => COLUMNS.find((c) => c.id === column)?.dot ?? 'bg-bambu-gray';

  const cards = (data.stage_time ?? [])
    .map((row) => ({ ...row, total: Object.values(row.stages).reduce((s, v) => s + v, 0) }))
    .sort((a, b) => b.total - a.total);
  const longest = cards[0]?.total ?? 0;
  const rework = data.rework;

  return (
    <div className="grid gap-4 lg:grid-cols-[3fr_1fr]">
      <Card testId="aito-stats-flow">
        <Heading>{t('aito.stats.flow')}</Heading>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {data.stage_days.map((s) => (
            <div
              key={s.column}
              title={t('stats.pipelineSample', { count: s.sample })}
              className="rounded-lg bg-bambu-dark px-2 py-2 text-center"
            >
              <div className="flex items-center justify-center gap-1.5 text-[11px] text-bambu-gray min-w-0">
                <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${dot(s.column)}`} aria-hidden="true" />
                <span className="truncate">{label(s.column)}</span>
              </div>
              <div className="text-sm font-medium text-white">{days(s.median_days)}</div>
            </div>
          ))}
        </div>
      </Card>

      <Card testId="aito-stats-rework">
        <Heading>{t('aito.stats.rework')}</Heading>
        {rework ? (
          <InnerTile
            label={t('aito.stats.reworkMoves', { count: rework.moves })}
            value={String(rework.moves)}
            sub={
              rework.share === null
                ? undefined
                : t('aito.stats.reworkShare', { cards: rework.cards, pct: Math.round(rework.share * 100) })
            }
            tone={rework.moves > 0 ? 'alert' : undefined}
          />
        ) : (
          <Empty>{t('aito.stats.empty')}</Empty>
        )}
      </Card>

      <Card testId="aito-stats-stage-time" className="lg:col-span-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <Heading>{t('aito.stats.stageTime')}</Heading>
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-bambu-gray-light">
            {COLUMNS.map((c) => (
              <li key={c.id} className="inline-flex items-center gap-1.5">
                <span className={`inline-block h-2 w-2 rounded-full ${c.dot}`} aria-hidden="true" />
                {t(c.labelKey)}
              </li>
            ))}
          </ul>
        </div>
        {cards.length > 0 ? (
          <ol className="space-y-1.5">
            {cards.map((row) => (
              <li key={row.project_id} className="flex items-center gap-3 text-xs">
                <span className="w-40 shrink-0 truncate text-bambu-gray-light sm:w-56" title={`${row.client_name ?? ''} · ${row.description}`}>
                  {row.client_name ? <span className="text-white">{row.client_name}</span> : null}
                  {row.client_name ? ' · ' : ''}
                  {row.description}
                </span>
                <span className="flex h-3 flex-1 gap-[2px]" style={{ width: longest > 0 ? `${(row.total / longest) * 100}%` : 0 }}>
                  {COLUMNS.map((c) =>
                    row.stages[c.id] > 0 ? (
                      <span
                        key={c.id}
                        className={`block h-full rounded-[2px] ${c.dot} min-w-[3px]`}
                        style={{ flexGrow: row.stages[c.id] }}
                        title={`${t(c.labelKey)} · ${days(row.stages[c.id])}`}
                      />
                    ) : null,
                  )}
                </span>
                <span className="w-14 shrink-0 text-right font-medium text-white">{days(row.total)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <Empty>{t('aito.stats.empty')}</Empty>
        )}
      </Card>
    </div>
  );
}
