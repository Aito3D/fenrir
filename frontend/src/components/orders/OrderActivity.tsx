import { api } from '../../api/client';
import type { OrderEvent } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { ActivityRail } from '../aito/history/ActivityRail';
import type { EventSource } from '../aito/history/ActivityRail';
import { orderEventLabel } from './orderEventKinds';

// The rail renders Aito's event shape; an order event just has no subject.
const asRailEvent = (e: OrderEvent) => ({ ...e, occurred_until: null, subject_type: null, subject_id: null, subject_label: null });

/** The order's history behind the side column's Activity tab: Aito's rail fed from the order's events. */
export function OrderActivity({ soId, currency }: { soId: string; currency: string }) {
  const { hasPermission } = useAuth();
  const source: EventSource = {
    key: ['order-events', soId],
    fetchPage: async (depth, cursor) => {
      const page = await api.getOrderEvents(soId, { depth, cursor, limit: 50 });
      return { ...page, events: page.events.map(asRailEvent) };
    },
    addNote: hasPermission('orders:update') ? async (body) => asRailEvent(await api.addOrderNote(soId, body)) : undefined,
    label: (event) => orderEventLabel(event, currency),
    depthKey: 'orders.history.depth',
    systemKey: 'orders.history.seenBySync',
  };
  return <ActivityRail source={source} showTitle={false} />;
}
