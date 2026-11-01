import { useTranslation } from 'react-i18next';
import type { HourMachine } from '../../../api/client';
import {
  behaviourFlag, familyOf, isoDayFormatter, periodPaces, ratePerMonth, seriesPoints, type MachineSeries,
} from '../../../utils/hoursSeries';

interface FocusHeaderProps {
  machine: HourMachine | null;
  series: MachineSeries | null;
  color: string;
  today: string;
  fleetLine: string;
  onOpen?: (id: number) => void;
}

/** One line above the chart: the fleet summary, or the machine under focus. */
export function FocusHeader({ machine, series, color, today, fleetLine, onOpen }: FocusHeaderProps) {
  const { t, i18n } = useTranslation();
  const wrap = 'mb-2 flex min-h-[1.75rem] flex-wrap items-center gap-x-3 gap-y-1 text-sm';
  const last = series?.manual.at(-1);
  const name = (m: HourMachine) => onOpen ? (
    <button type="button" onClick={() => onOpen(m.id)} className="rounded font-medium text-white hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40">
      {m.name}
    </button>
  ) : <span className="font-medium text-white">{m.name}</span>;

  if (!machine || !series || !last) {
    return (
      <div data-testid="hours-focus-header" className={`${wrap} text-bambu-gray`}>
        {machine ? name(machine) : fleetLine}
      </div>
    );
  }

  const fmt = isoDayFormatter(i18n.language);
  const prev = series.manual.at(-2);
  const rate = ratePerMonth(seriesPoints(series), today);
  const flag = machine.retired ? null : behaviourFlag(periodPaces(series.manual));

  return (
    <div data-testid="hours-focus-header" className={`${wrap} text-bambu-gray`}>
      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} aria-hidden="true" />
      {name(machine)}
      <span>{familyOf(machine)}</span>
      <span>{fmt(last.date)}</span>
      <span className="font-medium text-white">{`${Math.round(last.hours).toLocaleString(i18n.language)} h`}</span>
      {prev && (
        <span>{t('maintenance.hours.delta', { hours: Math.round(last.hours - prev.hours), date: fmt(prev.date) })}</span>
      )}
      <span>
        {rate !== null
          ? t('maintenance.hours.perMonth', { hours: Math.round(rate).toLocaleString(i18n.language) })
          : t('maintenance.hours.lastReadingOn', { date: fmt(last.date) })}
      </span>
      {flag && (
        <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-xs text-amber-400">
          {t(`maintenance.hours.flag.${flag}`)}
        </span>
      )}
    </div>
  );
}
