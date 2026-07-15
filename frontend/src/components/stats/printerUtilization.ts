import type { ArchiveSlim } from '../../api/client';
import { parseUTCDate, parseLocalDateKey } from '../../utils/date';

export interface PrinterUtilization {
  printerId: string;
  name: string;
  busySeconds: number;
  pct: number;
}

/** Merge overlapping [start, end] intervals and return total covered ms. */
function coveredMs(intervals: Array<[number, number]>): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curStart, curEnd] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const [start, end] = sorted[i];
    if (start <= curEnd) {
      curEnd = Math.max(curEnd, end);
    } else {
      total += curEnd - curStart;
      [curStart, curEnd] = [start, end];
    }
  }
  total += curEnd - curStart;
  return total;
}

/** Share of wall-clock time each printer spent printing in the window. */
export function computeUtilization(
  archives: ArchiveSlim[],
  printerMap: Map<string, string>,
  dateFrom?: string,
  dateTo?: string,
  now: number = Date.now(),
): PrinterUtilization[] {
  // Collect print intervals per printer
  const perPrinter = new Map<string, Array<[number, number]>>();
  let earliestStart = Infinity;
  archives.forEach((a) => {
    if (!a.printer_id || !a.started_at) return;
    const start = parseUTCDate(a.started_at)?.getTime();
    if (!start) return;
    const durationSec = a.actual_time_seconds ?? a.print_time_seconds ?? 0;
    const end = a.completed_at
      ? (parseUTCDate(a.completed_at)?.getTime() ?? start + durationSec * 1000)
      : start + durationSec * 1000;
    if (end <= start) return;
    earliestStart = Math.min(earliestStart, start);
    const id = String(a.printer_id);
    const list = perPrinter.get(id) || [];
    list.push([start, end]);
    perPrinter.set(id, list);
  });
  if (perPrinter.size === 0) return [];

  // Window: selected local days, clamped to now; all-time = first print → now
  const windowStart = dateFrom ? parseLocalDateKey(dateFrom).getTime() : earliestStart;
  const windowEnd = Math.min(
    dateTo ? parseLocalDateKey(dateTo).getTime() + 86400000 : now,
    now,
  );
  const windowMs = windowEnd - windowStart;
  if (windowMs <= 0) return [];

  return Array.from(perPrinter.entries())
    .map(([printerId, intervals]) => {
      const clipped = intervals
        .map(([s, e]): [number, number] => [Math.max(s, windowStart), Math.min(e, windowEnd)])
        .filter(([s, e]) => e > s);
      const busyMs = Math.min(coveredMs(clipped), windowMs);
      return {
        printerId,
        name: printerMap.get(printerId) || `#${printerId}`,
        busySeconds: busyMs / 1000,
        pct: (busyMs / windowMs) * 100,
      };
    })
    .sort((a, b) => b.pct - a.pct);
}
