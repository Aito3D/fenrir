import { useTranslation } from 'react-i18next';
import type { AitoStats } from '../../../api/client';
import { AITO_SERVICE_LABEL_KEYS } from '../services';
import { SERVICE_COLORS } from './palette';
import { AsOfToday, Card, Empty, Heading, InnerTile, Tile } from './primitives';
import { useStatsFormat } from './useStatsFormat';

/** Money: the three totals, what is overdue and by how long, and which
 *  service the accepted revenue comes from. */
export function MoneySection({ data }: { data: AitoStats }) {
  const { t } = useTranslation();
  const { money } = useStatsFormat();

  const quoted = data.conversion.accepted.total;
  const invoiced = data.invoicing.invoiced_total;
  const outstanding = data.invoicing.outstanding_balance;
  const showStrip = quoted + invoiced + outstanding > 0;

  const overdue = data.overdue;
  const overdueTotal = overdue?.buckets.reduce((s, b) => s + b.count, 0) ?? 0;

  const services = (data.services ?? []).filter((s) => s.tasks > 0);
  const revenue = services.reduce((s, row) => s + row.revenue, 0);

  return (
    <div className="space-y-4">
      {showStrip && (
        <div data-testid="aito-stats-money" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Tile label={t('aito.stats.quoted')} value={money(quoted)} small />
          <Tile label={t('aito.stats.invoiced')} value={money(invoiced)} small />
          <Tile label={t('aito.stats.outstanding')} value={money(outstanding)} small />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card testId="aito-stats-overdue">
          <div className="flex items-baseline justify-between gap-3">
            <Heading>{t('aito.stats.overdue')}</Heading>
            <AsOfToday
              extra={
                overdue?.oldest_days !== null && overdue?.oldest_days !== undefined
                  ? t('aito.stats.overdueOldest', { days: overdue.oldest_days })
                  : undefined
              }
            />
          </div>
          {!overdue ? (
            <Empty>{t('aito.stats.empty')}</Empty>
          ) : overdueTotal === 0 ? (
            <p className="py-6 text-center text-sm text-bambu-gray">{t('aito.stats.nothingOverdue')}</p>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {overdue.buckets.map((b) => (
                <InnerTile
                  key={b.bucket}
                  label={t('aito.stats.ageDays', { range: b.bucket.replace('-', '–') })}
                  value={String(b.count)}
                  sub={b.count > 0 ? money(b.balance) : undefined}
                  tone={b.count > 0 ? 'alert' : undefined}
                />
              ))}
            </div>
          )}
        </Card>

        <Card testId="aito-stats-service-mix">
          <Heading>{t('aito.stats.serviceMix')}</Heading>
          {services.length > 0 && revenue > 0 ? (
            <>
              <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-full" aria-hidden="true">
                {services.map((s) => (
                  <span
                    key={s.service}
                    className="block h-full min-w-[4px] rounded-[2px]"
                    style={{ flexGrow: s.revenue, backgroundColor: SERVICE_COLORS[s.service] ?? '#808080' }}
                    title={`${t(AITO_SERVICE_LABEL_KEYS[s.service] ?? s.service)} · ${money(s.revenue)}`}
                  />
                ))}
              </div>
              <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-bambu-gray-light">
                {services.map((s) => (
                  <li key={s.service} className="flex items-center gap-1.5 min-w-0">
                    <span
                      aria-hidden="true"
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: SERVICE_COLORS[s.service] ?? '#808080' }}
                    />
                    <span className="truncate">
                      <span className="text-white">{t(AITO_SERVICE_LABEL_KEYS[s.service] ?? s.service)}</span> ·{' '}
                      {t('aito.stats.serviceTasks', { count: s.tasks })} · {money(s.revenue)} ·{' '}
                      {Math.round((s.revenue / revenue) * 100)}%
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <Empty>{t('aito.stats.empty')}</Empty>
          )}
        </Card>
      </div>
    </div>
  );
}
