import { useTranslation } from 'react-i18next';
import type { HourReading } from '../../../api/client';
import { Button } from '../../Button';

interface ReadingLogProps {
  readings: HourReading[];
  today: string;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: (date: string) => void;
  onDelete: (date: string) => void;
}

interface LogRow {
  date: string;
  source: 'manual' | 'auto';
  count: number;
  sum: number;
}

export function ReadingLog({ readings, today, canEdit, canDelete, onEdit, onDelete }: ReadingLogProps) {
  const { t, i18n } = useTranslation();
  const dayFmt = new Intl.DateTimeFormat(i18n.language, { timeZone: 'UTC' });
  const byDate = new Map<string, LogRow>();
  for (const r of readings) {
    if (r.source === 'auto' && r.reading_date !== today) continue;
    const key = `${r.reading_date}|${r.source}`;
    const row = byDate.get(key) ?? { date: r.reading_date, source: r.source, count: 0, sum: 0 };
    row.count += 1;
    row.sum += r.hours;
    byDate.set(key, row);
  }
  const rows = [...byDate.values()].sort((a, b) =>
    a.date === b.date ? (a.source === 'auto' ? -1 : 1) : b.date.localeCompare(a.date),
  );

  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-bambu-gray">{t('maintenance.hours.empty')}</p>;
  }
  return (
    <div data-testid="hours-reading-log" className="flex flex-col">
      {rows.map((row) => (
        <div
          key={`${row.date}-${row.source}`}
          data-testid="hours-log-row"
          data-date={row.date}
          data-source={row.source}
          className="flex items-center gap-3 border-b border-bambu-dark-tertiary py-2.5 text-sm last:border-b-0"
        >
          <span className={`rounded-full px-2 py-0.5 text-[0.7rem] ${row.source === 'manual' ? 'bg-bambu-green/20 text-bambu-green' : 'bg-bambu-dark-tertiary text-bambu-gray-light'}`}>
            {t(`maintenance.hours.${row.source}`)}
          </span>
          <span className="font-semibold text-white">
            {row.source === 'auto' ? t('maintenance.hours.autoToday') : dayFmt.format(new Date(`${row.date}T00:00:00Z`))}
          </span>
          <span className="text-bambu-gray">{t('maintenance.hours.machineCount', { n: row.count })}</span>
          <span className="ml-auto tabular-nums text-bambu-gray">Σ {Math.round(row.sum).toLocaleString(i18n.language)} h</span>
          {row.source === 'manual' && canEdit && (
            <Button variant="secondary" size="sm" onClick={() => onEdit(row.date)}>{t('common.edit')}</Button>
          )}
          {row.source === 'manual' && canDelete && (
            <Button variant="ghost" size="sm" onClick={() => onDelete(row.date)}>{t('common.delete')}</Button>
          )}
        </div>
      ))}
    </div>
  );
}
