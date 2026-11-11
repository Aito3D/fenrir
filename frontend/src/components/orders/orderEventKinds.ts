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

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The line under an order event's sentence ("8 unités · 192,00 € · retrait en boutique"); null when nothing adds to it.
 *  A phone or e-mail address is shown, never an SMS body (none is stored). */
export function orderEventDetail(event: Pick<OrderEvent, 'kind' | 'detail'>, currency: string, t: Translate): string | null {
  const d = event.detail ?? {};
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  const money = (v: unknown) => (typeof v === 'number' ? formatMoney(v, currency) : null);
  const units = num(d.units) === null ? null : t('orders.units', { count: d.units });
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const join = (parts: (string | null)[]) => parts.filter(Boolean).join(' · ') || null;
  switch (event.kind) {
    case 'order.received':
      return join([units, money(d.total), d.pickup ? t('orders.history.sub.pickup') : null]);
    case 'picklist.created':
      return units;
    case 'package.created':
      return join([units, str(d.picklist) && t('orders.history.sub.fromPicklist', { picklist: d.picklist })]);
    case 'invoice.created':
      return join([money(d.total), num(d.credit_applied) ? t('orders.history.sub.credit', { amount: money(d.credit_applied) }) : null]);
    case 'payment.received':
      return money(d.paid) && money(d.total) ? t('orders.history.sub.paidOf', { paid: money(d.paid), total: money(d.total) }) : null;
    case 'order.edited':
      return money(d.total_from) && money(d.total_to)
        ? t('orders.history.sub.total', { from: money(d.total_from), to: money(d.total_to) })
        : null;
    case 'sms.sent':
    case 'invoice.emailed':
      return str(d.to);
    case 'prep.printed':
      return str(d.picklist);
    case 'terminal.started':
    case 'payment_link.sent':
      return join([money(d.amount), str(d.document)]);
  }
  return null;
}
