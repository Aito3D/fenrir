import { useTranslation } from 'react-i18next';
import type { HourReading } from '../../../api/client';
import { dayNumber } from '../../../utils/hoursSeries';

interface ReadingTimelineProps {
  readings: HourReading[];
  today: string;
  due: boolean;
  onPick: (date: string) => void;
}

const MIN_LABEL_GAP_PCT = 6;

function dotSize(count: number): string {
  if (count < 5) return 'h-2 w-2';
  if (count < 12) return 'h-2.5 w-2.5';
  return 'h-3 w-3';
}

export function ReadingTimeline({ readings, today, due, onPick }: ReadingTimelineProps) {
  const { t, i18n } = useTranslation();
  const byDate = new Map<string, { date: string; count: number; sum: number }>();
  for (const r of readings) {
    if (r.source !== 'manual') continue;
    const row = byDate.get(r.reading_date) ?? { date: r.reading_date, count: 0, sum: 0 };
    row.count += 1;
    row.sum += r.hours;
    byDate.set(r.reading_date, row);
  }
  const dates = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (dates.length === 0) return null;

  const dayFmt = new Intl.DateTimeFormat(i18n.language, { timeZone: 'UTC' });
  const monthFmt = new Intl.DateTimeFormat(i18n.language, { month: 'short', year: '2-digit', timeZone: 'UTC' });
  const fmtDate = (iso: string) => dayFmt.format(dayNumber(iso) * 86_400_000);
  const first = dayNumber(dates[0].date);
  const span = dayNumber(today) - first;
  let lastLabelled = -Infinity;

  return (
    <div className="relative mx-3 mt-2 h-10 border-t border-bambu-dark-tertiary">
      {dates.map((d) => {
        const pct = span > 0 ? ((dayNumber(d.date) - first) / span) * 100 : 0;
        const showLabel = pct - lastLabelled >= MIN_LABEL_GAP_PCT;
        if (showLabel) lastLabelled = pct;
        const text = `${fmtDate(d.date)} · ${t('maintenance.hours.machineCount', { n: d.count })} · Σ ${Math.round(d.sum).toLocaleString(i18n.language)} h`;
        return (
          <div key={d.date}>
            <button
              type="button"
              aria-label={text}
              title={text}
              data-testid="hours-timeline-dot"
              data-date={d.date}
              onClick={() => onPick(d.date)}
              className={`absolute -top-[5px] -translate-x-1/2 rounded-full bg-bambu-green ${dotSize(d.count)}`}
              style={{ left: `${pct}%` }}
            />
            {showLabel && (
              <span
                aria-hidden="true"
                className="absolute top-2.5 -translate-x-1/2 whitespace-nowrap text-[0.65rem] text-bambu-gray"
                style={{ left: `${pct}%` }}
              >
                {monthFmt.format(dayNumber(d.date) * 86_400_000)}
              </span>
            )}
          </div>
        );
      })}
      {due && (
        <div>
          <span
            data-testid="hours-timeline-today"
            className="absolute -top-[5px] h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-amber-400"
            style={{ left: '100%' }}
          />
          <span
            className="absolute top-2.5 -translate-x-1/2 whitespace-nowrap text-[0.65rem] text-amber-400"
            style={{ left: '100%' }}
          >
            {t('maintenance.hours.timeline.today')}
          </span>
        </div>
      )}
    </div>
  );
}
