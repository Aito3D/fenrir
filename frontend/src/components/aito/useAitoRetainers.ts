import { useQuery } from '@tanstack/react-query';
import { api, type AitoProject } from '../../api/client';

/** Same five minutes as `useAitoInvoice`, for the same reason: a payment
 *  status that changes the afternoon the client pays. */
const RETAINERS_STALE_MS = 5 * 60_000;

/** Whether this project can plausibly have a retainer invoice, from the
 *  project row alone. The list costs TWO Books calls (estimate + the
 *  customer's retainers), so a quoted, unpaid job — the commonest card on
 *  the board — must never pay it. Any of: a paid deposit the sweep has seen,
 *  customer credit on account, an invoiced quote (its deposit may have been
 *  spent, which zeroes the first two), or an 'unmanaged' card the sweep
 *  never touches (see `mayHaveInvoice`).
 *
 *  Documented limit: a retainer raised by hand in Books and still UNPAID
 *  shows up only once one of these becomes true. */
export function mayHaveRetainers(project: AitoProject): boolean {
  if (!project.quote_id) return false;
  return (
    (project.retainer_paid_total ?? 0) > 0 ||
    (project.customer_credit_total ?? 0) > 0 ||
    project.quote_invoiced ||
    project.quote_sync_state === 'unmanaged'
  );
}

/** The retainer (deposit) invoices Books holds for this project's quote,
 *  fetched live. One cache entry per project, shared by the Billing card's
 *  rows and the send-retainer mutation's cache write. */
export function useAitoRetainers(project: AitoProject) {
  return useQuery({
    queryKey: ['aito-retainers', project.id],
    queryFn: () => api.getAitoRetainers(project.id),
    enabled: mayHaveRetainers(project),
    staleTime: RETAINERS_STALE_MS,
    // A 502 (Zoho unreachable or unconfigured) does not self-heal within one
    // retry — same reasoning as `useAitoInvoice`.
    retry: false,
  });
}
