import type { AitoPaymentLink, AitoTerminalPayment } from '../../../api/client';

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
  if (terminal && (terminal.status === 'processing' || terminal.status === 'pending')) {
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
