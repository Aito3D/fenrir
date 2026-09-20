import { useTranslation } from 'react-i18next';
import type { AitoStats } from '../../../api/client';
import { AITO_SERVICE_LABEL_KEYS } from '../services';
import { SERVICE_COLORS } from './palette';
import { AsOfToday, Block, BlockHeading, Empty, Facts, Finding, HBars, Split } from './primitives';
import { useStatsFormat } from './useStatsFormat';

/** Money: the totals, what is still out and how late, where the accepted
 *  revenue comes from. */
export function MoneyScreen({ data }: { data: AitoStats }) {
  const { t } = useTranslation();
  const { money } = useStatsFormat();

  const quoted = data.conversion.accepted.total;
  const invoiced = data.invoicing.invoiced_total;
  const outstanding = data.invoicing.outstanding_balance;
  const outstandingCount = data.invoicing.outstanding_count;
  const overdue = data.overdue;
  const overdueCount = overdue?.buckets.reduce((s, b) => s + b.count, 0) ?? 0;
  const busiestBucket = Math.max(0, ...(overdue?.buckets ?? []).map((b) => b.count));

  // Biggest earner first: the order the finding reads them in.
  const services = (data.services ?? []).filter((s) => s.tasks > 0).sort((a, b) => b.revenue - a.revenue);
  const revenue = services.reduce((s, row) => s + row.revenue, 0);
  const topRevenue = Math.max(0, ...services.map((s) => s.revenue));
  const islands = data.islands ?? [];
  const parcels = islands.filter((i) => i.island !== null).reduce((s, i) => s + i.count, 0);
  const shipping = islands.reduce((s, i) => s + i.shipping_total, 0);

  const clauses: string[] = [];
  if (outstanding > 0) {
    clauses.push(t('aito.stats.finding.moneyOut', { amount: money(outstanding), invoices: t('aito.stats.facts.invoices', { count: outstandingCount }) }));
    if (overdueCount > 0 && overdue?.oldest_days != null) {
      clauses.push(t('aito.stats.finding.moneyOverdue', { count: overdueCount, days: overdue.oldest_days }));
    }
  } else {
    clauses.push(t('aito.stats.finding.moneyClear'));
  }

  return (
    <div className="grid gap-6">
      <Finding
        testId="aito-stats-finding"
        lead={t('aito.stats.finding.moneyTotals', { accepted: money(quoted), invoiced: money(invoiced) })}
        rest={clauses.join(' ')}
      />
      <Split>
        <div className="grid gap-6">
          <Block>
            <BlockHeading>{t('aito.stats.serviceMix')}</BlockHeading>
            {services.length > 0 && revenue > 0 ? (
              <HBars
                testId="aito-stats-service-mix"
                rows={services.map((s) => ({
                  key: s.service,
                  label: (
                    <>
                      <span className="text-white">{t(AITO_SERVICE_LABEL_KEYS[s.service] ?? s.service)}</span> ·{' '}
                      {t('aito.stats.serviceTasks', { count: s.tasks })}
                    </>
                  ),
                  scale: topRevenue > 0 ? s.revenue / topRevenue : 0,
                  segments: [{ weight: 1, color: SERVICE_COLORS[s.service] ?? '#808080' }],
                  value: (
                    <>
                      <span className="font-medium text-white">{Math.round((s.revenue / revenue) * 100)}%</span> · {money(s.revenue)}
                    </>
                  ),
                }))}
              />
            ) : (
              <p data-testid="aito-stats-service-mix" className="text-xs text-bambu-gray">
                {t('aito.stats.empty')}
              </p>
            )}
          </Block>
          <Block testId="aito-stats-overdue">
            <BlockHeading
              aside={
                <AsOfToday
                  extra={overdue?.oldest_days !== null && overdue?.oldest_days !== undefined ? t('aito.stats.overdueOldest', { days: overdue.oldest_days }) : undefined}
                />
              }
            >
              {t('aito.stats.overdue')}
            </BlockHeading>
            {!overdue ? (
              <Empty>{t('aito.stats.empty')}</Empty>
            ) : overdueCount === 0 ? (
              <p className="text-xs text-bambu-gray">{t('aito.stats.nothingOverdue')}</p>
            ) : (
              <HBars
                rows={overdue.buckets.map((b) => ({
                  key: b.bucket,
                  label: t('aito.stats.ageDays', { range: b.bucket.replace('-', '–') }),
                  scale: busiestBucket > 0 ? b.count / busiestBucket : 0,
                  // An empty bucket draws no bar at all — a 3px red stub
                  // beside a zero reads as something being overdue.
                  segments: b.count > 0 ? [{ weight: 1, cls: 'bg-status-error' }] : [],
                  value: (
                    <>
                      <span className={`font-medium ${b.count > 0 ? 'text-status-error' : 'text-white'}`}>{b.count}</span>
                      {b.count > 0 ? ` · ${money(b.balance)}` : ''}
                    </>
                  ),
                }))}
              />
            )}
          </Block>
        </div>
        <Facts
          testId="aito-stats-money"
          rows={[
            { label: t('aito.stats.quoted'), value: money(quoted), note: data.conversion.accepted.count },
            { label: t('aito.stats.invoiced'), value: money(invoiced), note: t('aito.stats.facts.invoices', { count: data.invoicing.invoiced_count }) },
            {
              label: t('aito.stats.outstanding'),
              value: money(outstanding),
              note: outstandingCount > 0 ? t('aito.stats.facts.invoices', { count: outstandingCount }) : undefined,
              tone: outstanding > 0 ? 'alert' : undefined,
            },
            { label: t('aito.stats.facts.lostWith'), value: money(data.conversion.declined.total), note: data.conversion.declined.count },
            { label: t('aito.stats.facts.shippingBilled'), value: money(shipping), note: t('aito.stats.facts.parcels', { count: parcels }) },
          ]}
        />
      </Split>
    </div>
  );
}
