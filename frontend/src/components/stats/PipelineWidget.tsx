import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { api, type AitoStats, type AitoStatsBucket } from '../../api/client';
import { ALL_COLUMNS } from '../aito/columns';
import { formatMoney } from '../../utils/pricing';
import { useCurrency } from '../../hooks/useCurrency';

/** The Stats page's Aito pipeline: money by stage, quote conversion, days
 *  per stage, invoicing. One endpoint, four sections; the board and the
 *  outstanding balance are snapshots, the rest follow the page's range. */
export function PipelineWidget({ dateFrom, dateTo }: { dateFrom?: string; dateTo?: string }) {
  const { t } = useTranslation();
  const currency = useCurrency();
  const { data, isLoading } = useQuery({
    queryKey: ['aitoStats', dateFrom, dateTo],
    queryFn: () => api.getAitoStats({ dateFrom, dateTo }),
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-4">
        <Loader2 className="w-6 h-6 text-bambu-green animate-spin" />
      </div>
    );
  }
  if (!data || isEmpty(data)) {
    return <p className="text-bambu-gray text-center py-4">{t('stats.aitoPipelineEmpty')}</p>;
  }

  const money = (v: number) => formatMoney(v, currency);
  const working = data.board.filter((b) => b.column !== 'done');
  const done = data.board.find((b) => b.column === 'done');
  const barTotal = working.reduce((s, b) => s + b.total, 0);
  const label = (column: string) => t(ALL_COLUMNS.find((c) => c.id === column)?.labelKey ?? column);
  const dot = (column: string) => ALL_COLUMNS.find((c) => c.id === column)?.dot ?? 'bg-bambu-gray';
  const rate = data.conversion.acceptance_rate;

  return (
    <div data-testid="aito-pipeline-widget" className="space-y-5">
      <section data-testid="pipeline-board" className="space-y-2">
        <Heading>{t('stats.pipelineByStage')}</Heading>
        <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-bambu-dark-tertiary">
          {working.map((b) => (
            <div
              key={b.column}
              title={`${label(b.column)} · ${b.count} · ${money(b.total)}`}
              className={`${dot(b.column)} min-w-[4px]`}
              style={{ flexGrow: barTotal > 0 ? b.total : 1 }}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {working.map((b) => (
            <span key={b.column} className="inline-flex items-center gap-1.5 text-bambu-gray-light">
              <span className={`inline-block h-2 w-2 rounded-full ${dot(b.column)}`} aria-hidden="true" />
              {label(b.column)} · <span className="tabular-nums">{b.count}</span> · <span className="tabular-nums">{money(b.total)}</span>
            </span>
          ))}
          {done && (
            <span className="ml-auto rounded-full bg-bambu-dark-tertiary px-2 py-0.5 text-bambu-gray tabular-nums">
              {label('done')} {done.count}
            </span>
          )}
        </div>
      </section>

      <section data-testid="pipeline-conversion" className="space-y-2">
        <Heading>{t('stats.pipelineConversion')}</Heading>
        <div className="grid grid-cols-3 gap-3">
          <Tile label={t('stats.pipelineSent')} bucket={data.conversion.sent} money={money} />
          <Tile
            label={t('stats.pipelineAccepted')}
            bucket={data.conversion.accepted}
            money={money}
            extra={rate === null ? '—' : t('stats.pipelineAcceptedRate', { pct: Math.round(rate * 100) })}
          />
          <Tile label={t('stats.pipelineDeclined')} bucket={data.conversion.declined} money={money} />
        </div>
      </section>

      <section data-testid="pipeline-stage-days" className="space-y-2">
        <Heading>{t('stats.pipelineStageDays')}</Heading>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {data.stage_days.map((s) => (
            <div
              key={s.column}
              title={t('stats.pipelineSample', { count: s.sample })}
              className="rounded-lg bg-bambu-dark px-2 py-1.5 text-center"
            >
              <div className="truncate text-[11px] text-bambu-gray">{label(s.column)}</div>
              <div className="text-sm font-medium text-white tabular-nums">
                {s.median_days === null ? '—' : t('stats.pipelineDays', { days: s.median_days.toFixed(1) })}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section data-testid="pipeline-invoicing" className="space-y-2">
        <Heading>{t('stats.pipelineInvoicing')}</Heading>
        <div className="grid grid-cols-2 gap-3">
          <Tile
            label={t('stats.pipelineInvoiced')}
            bucket={{ count: data.invoicing.invoiced_count, total: data.invoicing.invoiced_total }}
            money={money}
          />
          <Tile
            label={t('stats.pipelineOutstanding')}
            bucket={{ count: data.invoicing.outstanding_count, total: data.invoicing.outstanding_balance }}
            money={money}
          />
        </div>
      </section>
    </div>
  );
}

function isEmpty(d: AitoStats): boolean {
  return (
    d.board.every((b) => b.count === 0) &&
    d.conversion.sent.count + d.conversion.accepted.count + d.conversion.declined.count === 0 &&
    d.stage_days.every((s) => s.sample === 0) &&
    d.invoicing.invoiced_count + d.invoicing.outstanding_count === 0
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <h3 className="text-[11px] font-bold uppercase tracking-wider text-bambu-gray">{children}</h3>;
}

function Tile({
  label,
  bucket,
  money,
  extra,
}: {
  label: string;
  bucket: AitoStatsBucket;
  money: (v: number) => string;
  extra?: string;
}) {
  return (
    <div className="rounded-lg bg-bambu-dark px-3 py-2">
      <div className="text-xs text-bambu-gray">{label}</div>
      <div className="text-lg font-semibold text-white tabular-nums">{bucket.count}</div>
      <div className="text-xs text-bambu-gray-light tabular-nums">{money(bucket.total)}</div>
      {extra && <div className="mt-0.5 text-xs text-bambu-green">{extra}</div>}
    </div>
  );
}
