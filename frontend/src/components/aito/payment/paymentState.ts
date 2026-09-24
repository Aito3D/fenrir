import type { TFunction } from 'i18next';
import type { AitoPaymentLink, AitoProject, AitoTerminalPayment } from '../../../api/client';
import { localDateKey, parseLocalDateKey, parseUTCDate } from '../../../utils/date';

/** How long a `pending` terminal row may be taken for a charge in flight.
 *  Mirrors the backend's `ABANDONED_RESERVATION_SECONDS` (spec §4.3, amended
 *  2026-09-23): a row stays `pending` with no `heimdall_id` when the handler
 *  died before Heimdall answered, and that looks exactly like a card being
 *  presented right now. Past this age the backend's own sweep has written the
 *  row off, so the block must stop showing a spinner and re-enable the cells. */
const RESERVATION_MAX_AGE_MS = 10 * 60 * 1000;

/** An unparseable or missing `created_at` counts as live: the conservative
 *  side of this test keeps the cells locked rather than inviting a second
 *  charge on a project that may have one in flight. */
function isLiveReservation(payment: AitoTerminalPayment): boolean {
  const started = parseUTCDate(payment.created_at);
  if (!started || Number.isNaN(started.getTime())) return true;
  return Date.now() - started.getTime() < RESERVATION_MAX_AGE_MS;
}

export type PaymentState =
  | { kind: 'terminal_processing'; payment: AitoTerminalPayment }
  | { kind: 'terminal_attention'; payment: AitoTerminalPayment }
  | { kind: 'link_pending'; link: AitoPaymentLink }
  | { kind: 'paid'; amount: number; channel: 'terminal' | 'link'; at: string | null; bookingFailed: boolean }
  | { kind: 'link_dead'; link: AitoPaymentLink }
  | { kind: 'none' };

/** Spec §3.2: first match wins. A charge in flight (or one waiting for a
 *  human) outranks a link; a live link outranks history; the newest settled
 *  payment is the history line. */
export function derivePaymentState(
  link: AitoPaymentLink | null | undefined,
  terminal: AitoTerminalPayment | null | undefined,
): PaymentState {
  if (terminal && (terminal.status === 'processing' || (terminal.status === 'pending' && isLiveReservation(terminal)))) {
    return { kind: 'terminal_processing', payment: terminal };
  }
  if (terminal && terminal.status === 'needs_attention') return { kind: 'terminal_attention', payment: terminal };
  if (link && link.state === 'pending' && link.minted && link.url) return { kind: 'link_pending', link };
  const paidLink = link && link.state === 'paid' ? { at: link.paid_at, amount: link.amount } : null;
  const paidTerminal = terminal && terminal.status === 'paid'
    ? { at: terminal.settled_at, amount: terminal.amount_confirmed ?? terminal.amount, bookingFailed: terminal.booking_status === 'failed' }
    : null;
  if (paidLink || paidTerminal) {
    const terminalWins = paidTerminal && (!paidLink || (paidTerminal.at ?? '') >= (paidLink.at ?? ''));
    if (terminalWins && paidTerminal) {
      return { kind: 'paid', amount: paidTerminal.amount, channel: 'terminal', at: paidTerminal.at, bookingFailed: paidTerminal.bookingFailed };
    }
    if (paidLink) return { kind: 'paid', amount: paidLink.amount, channel: 'link', at: paidLink.at, bookingFailed: false };
  }
  if (link && (link.state === 'expired' || link.state === 'failed' || link.state === 'cancelled')) return { kind: 'link_dead', link };
  return { kind: 'none' };
}

export function blockVisible(due: number | null, state: PaymentState): boolean {
  if (due !== null && due > 0) return true;
  return state.kind === 'terminal_processing' || state.kind === 'terminal_attention' || state.kind === 'link_pending' || state.kind === 'paid';
}

export function cellsEnabled({ canUpdate, due, state }: { canUpdate: boolean; due: number | null; state: PaymentState }): boolean {
  return canUpdate && due !== null && due > 0 && state.kind !== 'terminal_processing';
}

/** The project's terminal payment, but only when it belongs to the document
 *  kind asking for it — a quote's block must never show an invoice's charge
 *  and vice versa. `project.terminal_payment` can arrive `undefined` on an
 *  older cached row, so this tolerates that the same way it tolerates
 *  `null`. (Task 16.) */
export function terminalFor(project: AitoProject, kind: 'quote' | 'invoice'): AitoTerminalPayment | null {
  const terminal = project.terminal_payment;
  return terminal && terminal.document_kind === kind ? terminal : null;
}

/** "Expires in N days" / "Expires today" / "Expired" for a link's
 *  `expires_on` (an ISO `YYYY-MM-DD`, UTC end-of-day). `title` is the long
 *  localized date for a tooltip. Shared by `PaymentLinkModal`'s live view and
 *  `PaymentBlock`'s `link_pending` state line, so the two can never disagree
 *  about the count. */
export function expiryText(t: TFunction, expiresOn: string, language: string): { text: string; title: string } {
  const expiresDate = parseLocalDateKey(expiresOn);
  const title = expiresDate.toLocaleDateString(language, { day: 'numeric', month: 'long', year: 'numeric' });
  // Whole calendar days from local midnight today to the expiry date, so a
  // link expiring tomorrow reads "1 day" all day long regardless of hour.
  const daysLeft = Math.round(
    (expiresDate.getTime() - parseLocalDateKey(localDateKey(new Date())).getTime()) / 86_400_000,
  );
  const text =
    daysLeft > 0
      ? t('aito.paymentLink.expiresIn', { count: daysLeft })
      : daysLeft === 0
        ? t('aito.paymentLink.expiresToday')
        : t('aito.paymentLink.state.expired');
  return { text, title };
}
