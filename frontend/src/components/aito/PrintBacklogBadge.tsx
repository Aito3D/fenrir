import { useTranslation } from 'react-i18next';
import { Clock } from 'lucide-react';
import { dailyCapacityHours, formatBacklogHours } from '../../utils/aitoBacklog';

export function PrintBacklogBadge({
  minutes,
  printerCount,
  dailyHours,
}: {
  minutes: number;
  printerCount?: number;
  dailyHours: number[];
}) {
  const { t } = useTranslation();
  if (minutes <= 0) return null;
  const hours = formatBacklogHours(minutes);
  // Capacity (and therefore the days estimate) needs a real printer count.
  // `undefined` means the printers query hasn't resolved yet, or errored
  // (e.g. a 403 for a role without printers:read) — either way, showing a
  // days figure would fabricate a capacity that was never actually known.
  const capacityKnown = printerCount !== undefined;
  let title = t('aito.backlogTitle');
  let daysLabel: string | null = null;
  if (capacityKnown) {
    const printers = Math.max(1, printerCount);
    const capacity = dailyCapacityHours(printerCount, dailyHours);
    const rawDays = minutes / 60 / capacity;
    const days = rawDays < 0.1 ? '< 0.1' : rawDays.toFixed(1);
    const perPrinter = capacity / printers;
    const perPrinterStr = Number.isInteger(perPrinter) ? String(perPrinter) : perPrinter.toFixed(1);
    title = `${t('aito.backlogTitle')} — ${hours} h ÷ (${printers} × ${perPrinterStr} h) ≈ ${days} d`;
    daysLabel = t('aito.backlogDays', { days, count: printers });
  }
  return (
    // animate-rise-sm on the pill: it mounts and unmounts with the backlog
    // (see the `minutes <= 0` return above), so it arrives with the small
    // rise rather than popping into the title row. The figures inside ride
    // their own keyed span so the tick below replays on every change without
    // remounting — and re-rising — the whole pill.
    <span
      data-testid="aito-print-backlog"
      title={title}
      className="animate-rise-sm inline-flex items-center gap-1.5 px-2 py-0.5 text-sm font-medium text-bambu-gray-light bg-bambu-dark-tertiary rounded-full tabular-nums"
    >
      <Clock className="w-3.5 h-3.5 text-orange-400" aria-hidden="true" />
      {/* Keyed on the hours so the value-tick replays when the figure
          changes — the same treatment its two neighbours in the h1 (the
          in-production count and the column badges) already get. Opacity
          only, so nothing in the row shifts. */}
      <span key={hours} className="inline-flex items-center gap-1.5 animate-value-tick">
        <span>{t('aito.backlogHours', { hours })}</span>
        {daysLabel !== null && <span className="text-bambu-gray">{daysLabel}</span>}
      </span>
    </span>
  );
}
