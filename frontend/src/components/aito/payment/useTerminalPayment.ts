import type { QueryClient } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../api/client';
import type { AitoProject, AitoTerminalPayment } from '../../../api/client';

export const TERMINAL_POLL_MS = 3000;

/** True while a terminal payment is still "open" — the operator is waiting
 *  on the card, or the card was accepted but Zoho Books hasn't recorded it
 *  yet. Drives both the polling interval and whether the waiting screen
 *  (vs. a settled one) is shown.
 *
 *  Mirrors the backend's `OPEN_STATUSES` (pending/processing) plus the
 *  `status == "paid" and booking_status == "pending"` half of
 *  `refresh_terminal_payment`'s `open_row` predicate
 *  (services/aito_terminal_payments.py). It deliberately does NOT mirror
 *  that predicate's other `paid`-row half, `settled_at is None` (added by
 *  c21 T-059): that catches a row adopted as `paid` whose settle claim
 *  never committed, which the operator already sees as settled — the
 *  backend's own GET refresh and sweep re-poll it to finish the event/quote
 *  acceptance without the SPA needing to keep polling. A new terminal
 *  status added to either predicate should be checked against the other. */
export function isTerminalOpen(p: AitoTerminalPayment | null | undefined): boolean {
  if (!p) return false;
  if (p.status === 'pending' || p.status === 'processing') return true;
  return p.status === 'paid' && p.booking_status === 'pending';
}

/** One terminal payment, re-read every 3 s while it is open (spec §3.4).
 *  The backend GET refreshes from Heimdall itself, throttled to 2 s. */
export function useTerminalPayment(projectId: number, paymentId: number | null, initial?: AitoTerminalPayment | null) {
  return useQuery({
    queryKey: ['aito-terminal-payment', projectId, paymentId],
    queryFn: () => api.getAitoTerminalPayment(projectId, paymentId as number),
    enabled: paymentId !== null,
    initialData: initial ?? undefined,
    refetchInterval: (query) => (isTerminalOpen(query.state.data) ? TERMINAL_POLL_MS : false),
    refetchIntervalInBackground: true,
    retry: false,
    staleTime: 0,
  });
}

/** Writes a settled (no longer open) terminal payment into the board cache
 *  and invalidates the three queries that depend on it — the invoice's own
 *  balance, the project's event log, and the board row's own snapshot
 *  fields. Shared by `TerminalPaymentModal` (while it is open) and
 *  `PaymentBlock` (which polls its own charge in flight even with the modal
 *  closed — see its doc), so the two settle paths can never drift apart. */
export function settleTerminalPaymentInCache(
  queryClient: QueryClient,
  projectId: number,
  payment: AitoTerminalPayment,
): void {
  queryClient.setQueryData<AitoProject[]>(['aito-projects'], (rows) =>
    rows?.map((r) => (r.id === projectId ? { ...r, terminal_payment: payment } : r)));
  queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
  queryClient.invalidateQueries({ queryKey: ['aito-invoice', projectId] });
  queryClient.invalidateQueries({ queryKey: ['aito-events', projectId] });
}
