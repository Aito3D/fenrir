import { useEffect, useMemo, useState } from 'react';
import { localDateKey } from '../../utils/date';

export type TimeframePreset =
  | 'today'
  | 'this-week'
  | 'this-month'
  | 'last-7'
  | 'last-30'
  | 'last-90'
  | 'this-year'
  | 'all-time'
  | 'custom';

export interface TimeframeState {
  preset: TimeframePreset;
  dateFrom: string | undefined; // YYYY-MM-DD
  dateTo: string | undefined; // YYYY-MM-DD
}

export interface DateRange {
  dateFrom?: string;
  dateTo?: string;
}

export function computeDateRange(preset: TimeframePreset): DateRange {
  // Ranges are the user's local calendar days; the API client sends the
  // browser's UTC offset alongside so the backend can build the UTC window.
  const now = new Date();
  const y = now.getFullYear(),
    m = now.getMonth(),
    d = now.getDate();
  const todayStr = localDateKey(now);

  switch (preset) {
    case 'today':
      return { dateFrom: todayStr, dateTo: todayStr };
    case 'this-week': {
      const day = now.getDay();
      const start = new Date(y, m, d - (day === 0 ? 6 : day - 1));
      return { dateFrom: localDateKey(start), dateTo: todayStr };
    }
    case 'this-month':
      return { dateFrom: localDateKey(new Date(y, m, 1)), dateTo: todayStr };
    case 'last-7':
      return { dateFrom: localDateKey(new Date(y, m, d - 6)), dateTo: todayStr };
    case 'last-30':
      return { dateFrom: localDateKey(new Date(y, m, d - 29)), dateTo: todayStr };
    case 'last-90':
      return { dateFrom: localDateKey(new Date(y, m, d - 89)), dateTo: todayStr };
    case 'this-year':
      return { dateFrom: localDateKey(new Date(y, 0, 1)), dateTo: todayStr };
    case 'all-time':
      return { dateFrom: undefined, dateTo: undefined };
    case 'custom':
      return {};
  }
}

export const TIMEFRAME_PRESETS: TimeframePreset[] = [
  'today',
  'this-week',
  'this-month',
  'last-7',
  'last-30',
  'last-90',
  'this-year',
  'all-time',
];

/** Timeframe state persisted under `storageKey`, plus the resolved date range
 *  the API takes. Presets resolve against "now" on every render so a tab left
 *  open overnight still means today's "Last 7 Days"; a custom range is used
 *  as typed. */
export function useTimeframe(storageKey: string, defaultPreset: TimeframePreset) {
  const [timeframe, setTimeframe] = useState<TimeframeState>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.preset) return parsed;
      }
    } catch {
      /* ignore */
    }
    return { preset: defaultPreset, dateFrom: undefined, dateTo: undefined };
  });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(timeframe));
    } catch {
      /* ignore */
    }
  }, [storageKey, timeframe]);

  const range = useMemo<DateRange>(() => {
    if (timeframe.preset === 'custom') {
      return { dateFrom: timeframe.dateFrom, dateTo: timeframe.dateTo };
    }
    return computeDateRange(timeframe.preset);
  }, [timeframe]);

  return { timeframe, setTimeframe, range };
}
