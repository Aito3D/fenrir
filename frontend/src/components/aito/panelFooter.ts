import type { AitoProject } from '../../api/client';
import { canCreateInvoice } from './canCreateInvoice';
import { canMarkDone } from './canMarkDone';
import { offersQuoteAction } from './quoteOffers';

/** Whether the expanded card's footer renders any action, decided by the
 *  same predicates its three actions use to render themselves away:
 *  CreateInvoiceButton (canCreateInvoice) and QuoteStatusActions (the quote
 *  status offers), both behind AITO_UPDATE, and ProjectDoneAction
 *  (canMarkDone), which is not. */
export function footerHasAction(project: AitoProject, canUpdate: boolean): boolean {
  if (canMarkDone(project)) return true;
  if (!canUpdate) return false;
  return canCreateInvoice(project) || offersQuoteAction(project.quote_status);
}

/** The quiet caption an empty footer shows instead, most specific first:
 *  trashed, invoiced, done, read-only, then "nothing to do here". */
export function footerCaptionKey(project: AitoProject, canUpdate: boolean): string {
  if (project.status === 'deleted') return 'aito.hintTrashed';
  if (project.quote_invoiced) return 'aito.hintInvoiced';
  if (project.column === 'done') return 'aito.footerDone';
  if (!canUpdate) return 'aito.footerReadOnly';
  return 'aito.footerNoAction';
}
