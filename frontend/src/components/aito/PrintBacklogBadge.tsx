import { useTranslation } from 'react-i18next';
import { Clock } from 'lucide-react';
import { dailyCapacityHours, formatBacklogHours } from '../../utils/aitoBacklog';

export function PrintBacklogBadge({
  minutes,
  printerCount,
  dailyHours,
}: {
  minutes: number;
  printerCount: number;
  dailyHours: number[];
}) {
  const { t } = useTranslation();
  if (minutes <= 0) return null;
  const hours = formatBacklogHours(minutes);
  const printers = Math.max(1, printerCount);
  const capacity = dailyCapacityHours(printerCount, dailyHours);
  const days = (minutes / 60 / capacity).toFixed(1);
  const perPrinter = (capacity / printers).toFixed(0);
  const title = `${t('aito.backlogTitle')} — ${hours} h ÷ (${printers} × ${perPrinter} h) ≈ ${days} d`;
  return (
    <span
      data-testid="aito-print-backlog"
      title={title}
      className="inline-flex items-center gap-1.5 px-2 py-0.5 text-sm font-medium text-bambu-gray-light bg-bambu-dark-tertiary rounded-full tabular-nums"
    >
      <Clock className="w-3.5 h-3.5 text-orange-400" aria-hidden="true" />
      <span>{t('aito.backlogHours', { hours })}</span>
      <span className="text-bambu-gray">{t('aito.backlogDays', { days, count: printers })}</span>
    </span>
  );
}
