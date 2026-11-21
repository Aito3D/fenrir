import { useTranslation } from 'react-i18next';
import { Empty, Facts, Panel } from '../aito/stats/primitives';
import { Skeleton } from '../Skeleton';
import { formatFcp } from './lib/format';
import type { PvmResponse } from './lib/types';
import { useRevenueResource } from './useRevenueResource';

const EFFECTS = ['volume', 'mix', 'price', 'new', 'lost'] as const;
const HINTS: Partial<Record<(typeof EFFECTS)[number], string>> = { volume: 'volumeHint', mix: 'mixHint', price: 'priceHint' };
const signed = (n: number) => `${n > 0 ? '+' : ''}${formatFcp(n)}`;
const dayMonth = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

function Bridge({ data }: { data: PvmResponse }) {
  const { t } = useTranslation();
  let running = data.previous;
  const steps = [
    { key: 'previous', label: t('revenue.bridge.previous'), from: 0, to: data.previous, text: formatFcp(data.previous), total: true },
    ...EFFECTS.map((k) => {
      const from = running;
      running += data[k];
      return { key: k, label: t(`revenue.bridge.${k}`), from, to: running, text: signed(data[k]), total: false };
    }),
    { key: 'current', label: t('revenue.bridge.current'), from: 0, to: data.current, text: formatFcp(data.current), total: true },
  ];
  const scale = Math.max(1, ...steps.map((s) => Math.max(s.from, s.to)));
  const pct = (v: number) => `${(Math.max(v, 0) / scale) * 100}%`;
  return (
    <ul data-testid="revenue-bridge" className="grid gap-1.5">
      {steps.map((s) => {
        const down = s.to < s.from;
        const hint = HINTS[s.key as (typeof EFFECTS)[number]];
        return (
          <li key={s.key} title={hint ? t(`revenue.bridge.${hint}`) : undefined}
            className="grid grid-cols-[minmax(7rem,11rem)_minmax(0,1fr)_auto] items-center gap-3 text-[13px]">
            <span className={s.total ? 'font-medium text-white' : 'text-bambu-gray-light'}>{s.label}</span>
            <span aria-hidden="true" className="relative block h-3 rounded-sm bg-bambu-dark">
              <span data-bar={s.total ? 'total' : down ? 'down' : 'up'}
                className={`absolute inset-y-0 min-w-[2px] rounded-sm ${s.total ? 'bg-bambu-gray' : down ? 'bg-status-error' : 'bg-bambu-green'}`}
                style={{ left: pct(Math.min(s.from, s.to)), width: pct(Math.abs(s.to - s.from)) }} />
            </span>
            <span className={`text-right tabular-nums ${s.total ? 'font-medium text-white' : down ? 'text-status-error' : 'text-white'}`}>{s.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** « Why did sales move? »: the change against the period just before, split into volume, mix, price, new and lost items. */
export function RevenueBridge({ from, to, filterParams, version }: { from: string; to: string; filterParams: string; version: unknown }) {
  const { t } = useTranslation();
  const { data, error } = useRevenueResource<PvmResponse>(`/api/v1/revenue/pvm?from=${from}&to=${to}${filterParams}`, version);
  return (
    <Panel title={t('revenue.bridge.title')}
      action={data ? <span className="text-[11px] text-bambu-gray">{t('revenue.bridge.versus', { from: dayMonth(data.previousFrom), to: dayMonth(data.previousTo) })}</span> : undefined}>
      {error ? <p role="alert" className="text-sm text-status-error">{error}</p> : !data ? <Skeleton className="h-40 w-full" />
        : data.previous === 0 && data.current === 0 ? <Empty>{t('revenue.bridge.empty')}</Empty> : (
          <div className="grid items-start gap-3 lg:grid-cols-2">
            <Bridge data={data} />
            {data.items.length > 0 && (
              <div className="space-y-1.5">
                <h3 className="text-[13px] font-medium text-white">{t('revenue.bridge.items')}</h3>
                <Facts rows={data.items.map((i) => ({
                  label: <span className="block truncate" title={i.name}>{i.name}</span>,
                  value: <span className={i.effect < 0 ? 'text-status-error' : undefined}>{signed(i.effect)}</span>,
                  note: i.kind === 'new' ? t('revenue.bridge.kindNew') : i.kind === 'lost' ? t('revenue.bridge.kindLost') : undefined,
                }))} />
              </div>
            )}
          </div>
        )}
    </Panel>
  );
}
