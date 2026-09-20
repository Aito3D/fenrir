import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { AitoStats } from '../../../api/client';
import { Block, BlockHeading, Empty, Facts, Finding, Split, type FactRow } from './primitives';
import { useStatsFormat } from './useStatsFormat';

const HOURS = Array.from({ length: 24 }, (_, h) => h);

/** Clients: who comes back, when requests land in the week, where parcels go. */
export function ClientsScreen({ data }: { data: AitoStats }) {
  const { t, i18n } = useTranslation();
  const { money } = useStatsFormat();

  const clients = data.clients;
  const total = clients ? clients.new_total + clients.returning_total : 0;
  const returningPct = clients && total > 0 ? Math.round((clients.returning_total / total) * 100) : null;

  // 2024-01-01 is a Monday: the weekday labels come from Intl, never hardcoded.
  const weekdays = useMemo(() => {
    const short = new Intl.DateTimeFormat(i18n.language, { weekday: 'short' });
    const long = new Intl.DateTimeFormat(i18n.language, { weekday: 'long' });
    return Array.from({ length: 7 }, (_, i) => ({ short: short.format(new Date(2024, 0, 1 + i)), long: long.format(new Date(2024, 0, 1 + i)) }));
  }, [i18n.language]);
  const grid = data.arrivals;
  const peak = grid ? Math.max(0, ...grid.flat()) : 0;
  const peakCell = useMemo(() => {
    if (!grid || peak === 0) return null;
    for (let d = 0; d < grid.length; d++) for (let h = 0; h < grid[d].length; h++) if (grid[d][h] === peak) return { d, h };
    return null;
  }, [grid, peak]);
  const shade = (n: number) => {
    if (n === 0 || peak === 0) return 'bg-bambu-dark-secondary';
    const r = n / peak;
    return r > 0.75 ? 'bg-bambu-green' : r > 0.5 ? 'bg-bambu-green/75' : r > 0.25 ? 'bg-bambu-green/50' : 'bg-bambu-green/30';
  };

  const islands = data.islands ?? [];
  const parcels = islands.filter((i) => i.island !== null).reduce((s, i) => s + i.count, 0);

  const clauses: string[] = [];
  if (peakCell) clauses.push(t('aito.stats.finding.clientsPeak', { day: weekdays[peakCell.d].long, hour: `${peakCell.h}:00` }));
  if (parcels > 0) clauses.push(t('aito.stats.finding.clientsParcels', { count: parcels }));
  const lead =
    !clients || clients.new + clients.returning === 0
      ? t('aito.stats.finding.clientsNone')
      : t('aito.stats.finding.clients', {
          new: t('aito.stats.finding.clientsNew', { count: clients.new }),
          returning: t('aito.stats.finding.clientsReturning', { count: clients.returning }),
        });

  const rows: FactRow[] = clients
    ? [
        { label: t('aito.stats.clientsNew'), value: clients.new, note: clients.new > 0 ? money(clients.new_total) : undefined },
        {
          label: t('aito.stats.clientsReturning'),
          value: clients.returning,
          note: clients.returning > 0 ? money(clients.returning_total) : undefined,
        },
      ]
    : [];

  return (
    <div className="grid gap-6">
      <Finding testId="aito-stats-finding" lead={lead} rest={clauses.length ? clauses.join(' ') : null} />
      <Split>
        <Block testId="aito-stats-arrivals">
          <BlockHeading>{t('aito.stats.arrivals')}</BlockHeading>
          {grid && grid.length === 7 ? (
            <div className="overflow-x-auto">
              {/* Capped: stretched across a wide column the cells become
                  big squares and the week stops reading as a grid. */}
              <div className="grid min-w-[26rem] max-w-[34rem] grid-cols-[2.25rem_repeat(24,minmax(0,1fr))] gap-[2px] text-[10px] text-bambu-gray">
                <span />
                {HOURS.map((h) => (
                  <span key={h} className="text-center">
                    {h % 6 === 0 ? h : ''}
                  </span>
                ))}
                {grid.map((row, d) => (
                  <div key={d} className="contents">
                    <span className="pr-1 leading-none self-center">{weekdays[d].short}</span>
                    {row.map((n, h) => (
                      <span key={h} title={`${weekdays[d].short} ${h}:00 · ${n}`} className={`aspect-square rounded-[2px] ${shade(n)}`} />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <Empty>{t('aito.stats.empty')}</Empty>
          )}
        </Block>
        <div className="grid gap-6">
          {clients ? (
            <div data-testid="aito-stats-clients" className="grid gap-1.5">
              <Facts rows={rows} />
              {returningPct !== null && (
                <p className="text-xs text-bambu-gray">{t('aito.stats.returningShare', { pct: returningPct })}</p>
              )}
            </div>
          ) : (
            <Empty>{t('aito.stats.empty')}</Empty>
          )}
          <Block>
            <BlockHeading>{t('aito.stats.islands')}</BlockHeading>
            {islands.length > 0 ? (
              <ul data-testid="aito-stats-islands" className="grid text-[13px]">
                {islands.map((row, i) => (
                  <li
                    key={row.island ?? '__pickup'}
                    className={`flex items-baseline justify-between gap-3 py-2 ${i === 0 ? '' : 'border-t border-bambu-dark-tertiary/70'}`}
                  >
                    <span className={row.island ? 'capitalize text-white' : 'text-bambu-gray-light'}>{row.island ?? t('aito.stats.pickup')}</span>
                    <span className="font-medium tabular-nums text-white">
                      {row.count}
                      {row.shipping_total > 0 ? <span className="ml-1.5 text-xs font-normal text-bambu-gray">{money(row.shipping_total)}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p data-testid="aito-stats-islands" className="text-xs text-bambu-gray">
                {t('aito.stats.empty')}
              </p>
            )}
          </Block>
        </div>
      </Split>
    </div>
  );
}
