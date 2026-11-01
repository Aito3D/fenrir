export const QUEUE_FILTER_STATUSES = [
  'pending', 'slicing', 'slice_failed', 'printing', 'completed', 'failed', 'skipped', 'cancelled',
] as const;

/** Whether any of the three queue filters is set. `-1` (unassigned) is a
 *  printer filter like any other id; only `null` means "all printers". */
export function hasActiveQueueFilter(filterPrinter: number | null, filterStatus: string, filterLocation: string): boolean {
  return filterPrinter !== null || filterStatus !== '' || filterLocation !== '';
}
