import { useQuery } from '@tanstack/react-query';
import { api, type AitoProject } from '../../api/client';

/** How long an invoice stays fresh before the panel re-asks Books.
 *
 *  Five minutes, not the hour `aito-shipping-services` uses: that is a rate
 *  card that changes twice a year, this is a payment status that changes the
 *  afternoon the client pays. Long enough that reopening the same panel a few
 *  times costs one request, short enough that "Unpaid" does not outlive the
 *  payment by a working day. */
const INVOICE_STALE_MS = 5 * 60_000;

/** Whether this project can have an invoice at all, without asking Books.
 *
 *  Gated twice over, and the second half is not redundant. `quote_invoiced`
 *  is the cheap, reliable signal — but it is written ONLY by the quote sync
 *  sweep, and a project left 'unmanaged' (legacy or imported cards the sync
 *  must never touch) never enters that sweep, so its flag stays false
 *  forever even when Books has invoiced it. Without the second clause those
 *  cards could never show an invoice at all. Managed projects therefore cost
 *  no request until they are actually billed; unmanaged ones pay one cached
 *  lookup per panel open, which is the only way they can ever be right. */
export function mayHaveInvoice(project: AitoProject): boolean {
  return Boolean(project.quote_id) && (project.quote_invoiced || project.quote_sync_state === 'unmanaged');
}

/** The Zoho invoice raised from this project's quote, fetched live.
 *
 *  One hook, shared by the Invoice card and the shipping label, so the two
 *  read the same cache entry and the panel never asks Books twice for one
 *  project. Every quote field is a snapshot on the project row and renders
 *  with Zoho unreachable, while this is fetched on panel open. That is
 *  deliberate (see `AitoInvoiceResponse`) — a stored "Unpaid" is wrong the
 *  moment the client pays, and a stale payment status is worse than an
 *  absent card.
 *
 *  `enabled` lets a caller add its own gate on top of `mayHaveInvoice` — the
 *  label button, for one, has no use for an invoice on a project it will not
 *  render for. */
export function useAitoInvoice(project: AitoProject, enabled = true) {
  return useQuery({
    queryKey: ['aito-invoice', project.id],
    queryFn: () => api.getAitoInvoice(project.id),
    enabled: enabled && mayHaveInvoice(project),
    staleTime: INVOICE_STALE_MS,
    // The app default is `retry: 1` (App.tsx). Overridden because the failure
    // this endpoint actually produces is a 502 — Zoho unreachable or
    // unconfigured — and neither self-heals within one retry. All a retry buys
    // is a second request against a failing upstream and another wait on its
    // 10s timeout, for a card that hides itself either way.
    retry: false,
  });
}
