import type { TimelineEvent } from '../../../api/client';
import { localDateKey, parseUTCDate } from '../../../utils/date';

export type TimelineDay = 'today' | 'yesterday' | 'earlier';

export interface TimelineGroup {
  day: TimelineDay;
  events: TimelineEvent[];
}

/** Which day header an event goes under, by the viewer's local calendar day
 *  (23:59 yesterday is "yesterday" even ten minutes later). Future or
 *  unparseable stamps count as today and earlier respectively. */
export function timelineDay(timestamp: string, now: Date = new Date()): TimelineDay {
  const date = parseUTCDate(timestamp);
  if (!date || Number.isNaN(date.getTime())) return 'earlier';
  const key = localDateKey(date);
  const today = localDateKey(now);
  if (key >= today) return 'today';
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return key === localDateKey(yesterday) ? 'yesterday' : 'earlier';
}

function stamp(event: TimelineEvent): number {
  const time = parseUTCDate(event.timestamp)?.getTime();
  return time === undefined || Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/** Newest first, then cut into consecutive Today / Yesterday / Earlier runs.
 *  The API already sorts descending; sorting again (stably) keeps the headers
 *  from repeating if it ever does not. */
export function groupTimeline(events: TimelineEvent[], now: Date = new Date()): TimelineGroup[] {
  const sorted = [...events].sort((a, b) => stamp(b) - stamp(a));
  const groups: TimelineGroup[] = [];
  for (const event of sorted) {
    const day = timelineDay(event.timestamp, now);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.events.push(event);
    else groups.push({ day, events: [event] });
  }
  return groups;
}
