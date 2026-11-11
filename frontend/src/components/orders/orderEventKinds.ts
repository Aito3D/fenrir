import type { OrderEvent } from '../../api/client';
import { formatMoney } from '../../utils/pricing';

// Explicit maps rather than template-literal keys: the i18n gate scans for literal keys.
const LABEL_KEY: Record<string, string> = {
  'order.received': 'orders.history.orderReceived',
  'order.ready': 'orders.history.orderReady',
  'picklist.created': 'orders.history.picklistCreated',
  'package.created': 'orders.history.packageCreated',
  'package.edited': 'orders.history.packageEdited',
  'handover.delivered': 'orders.history.handoverDelivered',
  'handover.shipped': 'orders.history.handoverShipped',
  'invoice.created': 'orders.history.invoiceCreated',
  'invoice.emailed': 'orders.history.invoiceEmailed',
  'payment.received': 'orders.history.paymentReceived',
  'order.edited': 'orders.history.orderEdited',
  'order.cancelled': 'orders.history.orderCancelled',
  'order.finished': 'orders.history.orderFinished',
  'note.added': 'orders.history.noteAdded',
  'sms.sent': 'orders.history.smsSent',
  'payment_link.sent': 'orders.history.paymentLinkSent',
  'terminal.started': 'orders.history.terminalStarted',
  'prep.printed': 'orders.history.prepPrinted',
  'tracking.viewed': 'orders.history.trackingViewed',
  'zoho.edited': 'orders.history.zohoEdited',
};

/** The row subtitle's noun phrase per kind ("SMS de retrait"). */
export const SHORT_LABEL_KEY: Record<string, string> = {
  'order.received': 'orders.history.short.received',
  'order.ready': 'orders.history.short.ready',
  'picklist.created': 'orders.history.short.picklist',
  'package.created': 'orders.history.short.package',
  'package.edited': 'orders.history.short.packageEdited',
  'handover.delivered': 'orders.history.short.delivered',
  'handover.shipped': 'orders.history.short.shipped',
  'invoice.created': 'orders.history.short.invoice',
  'invoice.emailed': 'orders.history.short.invoiceEmailed',
  'payment.received': 'orders.history.short.payment',
  'order.edited': 'orders.history.short.edited',
  'order.cancelled': 'orders.history.short.cancelled',
  'order.finished': 'orders.history.short.finished',
  'note.added': 'orders.history.short.note',
  'sms.sent': 'orders.history.short.sms',
  'payment_link.sent': 'orders.history.short.paymentLink',
  'terminal.started': 'orders.history.short.terminal',
  'prep.printed': 'orders.history.short.prepPrinted',
  'tracking.viewed': 'orders.history.short.trackingViewed',
  'zoho.edited': 'orders.history.short.zohoEdited',
};

const text = (value: unknown) => (typeof value === 'string' && value ? value : '—');

/** An order event's sentence: its i18n key and values; null for a kind this build does not know. */
export function orderEventLabel(
  event: Pick<OrderEvent, 'kind' | 'detail'>,
  currency: string,
): { key: string; params?: Record<string, unknown> } | null {
  const d = event.detail ?? {};
  switch (event.kind) {
    case 'order.received':
      if (d.source === 'shopify') return { key: 'orders.history.orderReceivedShopify', params: { reference: text(d.reference) } };
      if (d.source === 'quote') return { key: 'orders.history.orderReceivedQuote', params: { reference: text(d.reference) } };
      return { key: 'orders.history.orderReceived' };
    case 'package.edited':
      if (d.deleted) return { key: 'orders.history.packageDeleted', params: { package: text(d.package) } };
      return { key: 'orders.history.packageEdited', params: { package: text(d.package) } };
    case 'package.created':
    case 'handover.delivered':
    case 'handover.shipped':
      return { key: LABEL_KEY[event.kind], params: { package: text(d.package) } };
    case 'picklist.created':
      return { key: LABEL_KEY[event.kind], params: { picklist: text(d.picklist) } };
    case 'invoice.created':
    case 'invoice.emailed':
      return { key: LABEL_KEY[event.kind], params: { invoice: text(d.invoice) } };
    case 'payment.received':
      return {
        key: LABEL_KEY[event.kind],
        params: { amount: typeof d.amount === 'number' ? formatMoney(d.amount, currency) : '—' },
      };
  }
  const key = LABEL_KEY[event.kind];
  return key ? { key } : null;
}
