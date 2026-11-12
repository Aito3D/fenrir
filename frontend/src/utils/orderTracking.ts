import type { TFunction } from 'i18next';
import type { OrderTracking, OrderTrackingLineStatus } from '../api/client';

/** The public tracking page of a sales order (`/t/<code>`, the Aito cards' link shape): the copy and
 *  the rail, derived from the payload. The state itself is decided by the
 *  server (services/order_board_tracking.py); nothing here guesses. */

const STAGES = ['received', 'preparing', 'ready', 'handed_over'] as const;

/** A stage's index on the rail (0 = received … 3 = handed over). */
export const orderStageIndex = (stage: OrderTracking['stage']): number => STAGES.indexOf(stage);

export function orderStages(t: TFunction): { id: string; label: string }[] {
  return STAGES.map((id) => ({ id, label: t(`aito.track.order.stages.${id}`) }));
}

/** The state card. Counts are lines, as the list below it shows them. */
export function orderStatusCopy(data: OrderTracking, t: TFunction): { title: string; sub: string } {
  const key = (name: string, values?: Record<string, number>) => t(`aito.track.order.status.${name}`, values);
  const { open, ready, waiting } = data.counts;
  switch (data.state) {
    case 'received':
      return { title: key('receivedTitle'), sub: key('receivedSub') };
    case 'preparing': {
      let sub = key('preparingSub');
      if (waiting > 0 && waiting === open) sub = key('waitingAllSub');
      else if (waiting === 1) sub = key('waitingOneSub');
      else if (waiting > 1) sub = key('waitingManySub', { n: waiting });
      return { title: key('preparingTitle'), sub };
    }
    case 'partly_ready': {
      const pickup = ready === 1 ? key('partlyOneSub', { total: open }) : key('partlySub', { ready, total: open });
      return { title: key('partlyTitle'), sub: data.pickup ? pickup : key('deliverySub') };
    }
    case 'ready':
      return { title: key('readyTitle'), sub: key(data.pickup ? 'readySub' : 'deliverySub') };
    default:
      return { title: key('handedTitle'), sub: key('handedSub') };
  }
}

/** "12 novembre", in the page's language: a bare day is pinned to noon so no
 *  timezone rolls it over; a naive UTC moment is read in the browser's zone. */
function dayAndMonth(iso: string, lng: string): string {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  return new Intl.DateTimeFormat(lng, { day: 'numeric', month: 'long' }).format(new Date(day ? `${iso}T12:00:00` : `${iso}Z`));
}

/** A line's status, with the hand-over day when the server is sure of it. */
export function orderLineLabel(line: { status: OrderTrackingLineStatus; handed_on: string | null }, t: TFunction, lng: string): string {
  if (line.status === 'handed_over' && line.handed_on) return t('aito.track.order.line.handedOn', { date: dayAndMonth(line.handed_on, lng) });
  return t(`aito.track.order.line.${line.status}`);
}

/** Cyan for what can be collected, amber for what is held up, quiet otherwise. */
export const ORDER_LINE_TONE: Record<OrderTrackingLineStatus, string> = {
  ready: 'text-aito-cyan',
  waiting: 'text-amber-500',
  preparing: 'text-aito-muted',
  to_prepare: 'text-aito-muted',
  handed_over: 'text-aito-muted',
};

/** Lines per status, in list order: the tally above a long list. */
export function orderTally(lines: OrderTracking['lines']): { status: OrderTrackingLineStatus; n: number }[] {
  const counts = new Map<OrderTrackingLineStatus, number>();
  for (const line of lines) counts.set(line.status, (counts.get(line.status) ?? 0) + 1);
  return [...counts].map(([status, n]) => ({ status, n }));
}
