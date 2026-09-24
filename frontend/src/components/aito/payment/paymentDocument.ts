import type { AitoInvoice, AitoProject } from '../../../api/client';
import { requiredAmount } from '../../../utils/aitoPayment';

/** The Zoho document a PaymentBlock collects money for, and what is still
 *  due on it in whole francs. `id` is Zoho's own id (what Heimdall and the
 *  manual route need), `number` the human DEV…/FA… shown in the block. */
export interface PaymentDocument {
  kind: 'quote' | 'invoice';
  id: string;
  number: string;
  due: number | null;
  currency: string;
}

export function quoteDocument(project: AitoProject, depositPct: number, currency: string): PaymentDocument | null {
  if (!project.quote_id || !project.quote_number) return null;
  return {
    kind: 'quote',
    id: project.quote_id,
    number: project.quote_number,
    due: requiredAmount(project.quote_total, depositPct, project.retainer_paid_total),
    currency,
  };
}

export function invoiceDocument(invoice: AitoInvoice): PaymentDocument {
  const due = Math.ceil(invoice.balance);
  return { kind: 'invoice', id: invoice.id, number: invoice.number || invoice.id, due: due > 0 ? due : null, currency: invoice.currency_code };
}
