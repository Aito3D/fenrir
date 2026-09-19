import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { AitoStats } from '../../../api/client';
import { Card, Empty, Heading, InnerTile } from './primitives';
import { useStatsFormat } from './useStatsFormat';

const HOURS = Array.from({ length: 24 }, (_, h) => h);
// 2024-01-01 is a Monday: the weekday labels come from Intl, never hardcoded.
const MONDAY = new Date(2024, 0, 1);

/** Clients: who comes back, when requests land in the week, where parcels go. */
export function ClientsSection({ data }: { data: AitoStats }) {
  const { t, i18n } = useTranslation();
  const { money } = useStatsFormat();

  const clients = data.clients;
  const total = clients ? clients.new_total + clients.returning_total : 0;
  const returningPct = clients && total > 0 ? Math.round((clients.returning_total / total) * 100) : null;

  const weekdays = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(i18n.language, { weekday: 'short' });
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 1 + i)));
  }, [i18n.language]);
  const grid = data.arrivals;
  const peak = grid ? Math.max(0, ...grid.flat()) : 0;
  const shade = (n: number) => {
    if (n === 0 || peak === 0) return 'bg-bambu-dark-secondary';
    const r = n / peak;
    return r > 0.75 ? 'bg-bambu-green' : r > 0.5 ? 'bg-bambu-green/75' : r > 0.25 ? 'bg-bambu-green/50' : 'bg-bambu-green/30';
  };

  const islands = data.islands ?? [];
  void MONDAY;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card testId="aito-stats-clients">
        <Heading>{t('aito.stats.clientsHeading')}</Heading>
        {clients ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              <InnerTile label={t('aito.stats.clientsNew')} value={String(clients.new)} sub={clients.new > 0 ? money(clients.new_total) : undefined} />
              <InnerTile
                label={t('aito.stats.clientsReturning')}
                value={String(clients.returning)}
                sub={clients.returning > 0 ? money(clients.returning_total) : undefined}
              />
            </div>
            {returningPct !== null && (
              <p className="text-xs text-bambu-gray-light">{t('aito.stats.returningShare', { pct: returningPct })}</p>
            )}
          </>
        ) : (
          <Empty>{t('aito.stats.empty')}</Empty>
        )}
      </Card>

      <Card testId="aito-stats-islands">
        <Heading>{t('aito.stats.islands')}</Heading>
        {islands.length > 0 ? (
          <ul className="space-y-1 text-xs">
            {islands.map((row) => (
              <li key={row.island ?? '__pickup'} className="flex items-center justify-between gap-3 rounded-lg bg-bambu-dark-secondary px-3 py-1.5">
                <span className={row.island ? 'text-white capitalize' : 'text-bambu-gray-light'}>
                  {row.island ?? t('aito.stats.pickup')}
                </span>
                <span className="text-bambu-gray-light">
                  <span className="font-medium text-white">{row.count}</span>
                  {row.shipping_total > 0 ? ` · ${money(row.shipping_total)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{t('aito.stats.empty')}</Empty>
        )}
      </Card>

      <Card testId="aito-stats-arrivals" className="lg:col-span-2">
        <Heading>{t('aito.stats.arrivals')}</Heading>
        {grid && peak > 0 ? (
          <div className="overflow-x-auto">
            <div className="inline-grid gap-[2px]" style={{ gridTemplateColumns: `2.5rem repeat(24, 12px)` }}>
              <span />
              {HOURS.map((h) => (
                <span key={h} className="text-center text-[9px] text-bambu-gray" style={{ visibility: h % 3 === 0 ? 'visible' : 'hidden' }}>
                  {h}
                </span>
              ))}
              {grid.map((row, d) => (
                <div key={d} className="contents">
                  <span className="pr-1 text-right text-[10px] leading-3 text-bambu-gray">{weekdays[d]}</span>
                  {row.map((n, h) => (
                    <span key={h} className={`h-3 w-3 rounded-[2px] ${shade(n)}`} title={`${weekdays[d]} ${h}h · ${n}`} />
                  ))}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <Empty>{t('aito.stats.empty')}</Empty>
        )}
      </Card>
    </div>
  );
}
