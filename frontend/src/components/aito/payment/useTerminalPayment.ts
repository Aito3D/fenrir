import { useQuery } from '@tanstack/react-query';
import { api } from '../../../api/client';
import type { AitoTerminalPayment } from '../../../api/client';

export const TERMINAL_POLL_MS = 3000;

/** True while a terminal payment is still "open" — the operator is waiting
 *  on the card, or the card was accepted but Zoho Books hasn't recorded it
 *  yet. Drives both the polling interval and whether the waiting screen
 *  (vs. a settled one) is shown. */
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
