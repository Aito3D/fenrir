import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Banknote, Check, Copy, Link2, Loader2, Smartphone } from 'lucide-react';
import type { AitoPaymentLink, AitoProject, AitoTerminalPayment } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { copyTextToClipboard } from '../../../utils/clipboard';
import { formatMoney } from '../../../utils/pricing';
import { parseUTCDate } from '../../../utils/date';
import { ACTION_CELL, ACTION_GROUP } from '../quoteActionGroup';
import { LINK_ICON_BUTTON_CLS, LINK_ICON_CLS, useCopiedFlash } from '../linkActionHelpers';
import { CopiedLabel, OpenLinkButton } from '../linkActions';
import { ManualPaymentModal } from './ManualPaymentModal';
import { PaymentLinkModal } from './PaymentLinkModal';
import { TerminalPaymentModal } from './TerminalPaymentModal';
import type { PaymentDocument } from './paymentDocument';
import { blockVisible, cellsEnabled, derivePaymentState, expiryText, type PaymentState } from './paymentState';
import { isTerminalOpen, settleTerminalPaymentInCache, useTerminalPayment } from './useTerminalPayment';

type OpenModal = 'link' | 'terminal' | 'manual' | null;

/** The Encaissement block: what is still due on a quote's deposit or an
 *  invoice's balance, the one-line state of any charge or link already in
 *  motion, and — while there is something to collect and nothing already in
 *  flight — the three ways to collect it (spec §3.1-3.3). Mounted once under
 *  the quote's rows (`BillingCard`) and once under the invoice's (`InvoiceCard`),
 *  each with its own `PaymentDocument`, its own link and its own terminal
 *  payment (never the other document's).
 *
 *  Renders nothing when there is nothing due and nothing to report —
 *  `blockVisible` is the single source of truth for that, shared with the
 *  tests so the render rule can never drift from what they pin.
 *
 *  Polls its own charge in flight: while `terminal` is still open (waiting on
 *  the card, or paid but not yet booked in Zoho Books) this hooks into the
 *  same `useTerminalPayment` the modal uses, so the state line above moves to
 *  "paid" the moment Heimdall settles even if the operator never opened the
 *  waiting screen. The hook is called unconditionally — with `paymentId` set
 *  to `null` when nothing is open — because React requires hooks to run in
 *  the same order on every render. */
export function PaymentBlock({ project, document, link, terminal, canUpdate, heimdallConfigured }: {
  project: AitoProject;
  document: PaymentDocument;
  link: AitoPaymentLink | null;
  terminal: AitoTerminalPayment | null;
  canUpdate: boolean;
  heimdallConfigured: boolean;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [copied, flashCopied] = useCopiedFlash();
  const [open, setOpen] = useState<OpenModal>(null);

  // Only poll while there is something open to poll — the query is simply
  // disabled otherwise, never skipped, so this hook call itself is
  // unconditional.
  const openTerminalId = terminal && isTerminalOpen(terminal) ? terminal.id : null;
  const poll = useTerminalPayment(project.id, openTerminalId, terminal);
  const liveTerminal = openTerminalId !== null ? (poll.data ?? terminal) : terminal;

  // Settles the charge into the board cache itself, independently of
  // `TerminalPaymentModal`'s own identical effect: the modal only runs that
  // effect while it is mounted, and "Close, I will come back" is a designed
  // way to leave it before the charge settles. Without this, a payment that
  // finishes after the operator closes the modal would show "paid" here
  // (this block derives its own state from `poll.data`) while the head
  // amount and the three cells stayed stuck on the pre-payment figures until
  // the next unrelated board fetch. Reuses the same helper the modal calls,
  // so the two settle paths cannot drift apart.
  useEffect(() => {
    if (openTerminalId === null || !poll.data || isTerminalOpen(poll.data)) return;
    settleTerminalPaymentInCache(queryClient, project.id, poll.data);
  }, [openTerminalId, poll.data, project.id, queryClient]);

  const state = derivePaymentState(link ?? null, liveTerminal ?? null);
  const due = document.due;

  if (!blockVisible(due, state)) return null;

  const enabled = cellsEnabled({ canUpdate, due, state });
  const showCells = enabled || state.kind === 'terminal_processing';
  // Reopens the modal on whatever charge is genuinely still in flight — the
  // raw `terminal` prop, not the polled `liveTerminal`, per spec: once the
  // board refetches with a settled payment this simply stops offering one.
  const openTerminal = terminal && isTerminalOpen(terminal) ? terminal : null;

  const copyLink = async (url: string) => {
    if (await copyTextToClipboard(url)) {
      flashCopied();
    } else {
      showToast(t('common.errorLoading'), 'error');
    }
  };

  return (
    <div data-testid="payment-block" data-state={state.kind} className="mt-2 text-sm">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-bambu-gray">
          {t(document.kind === 'quote' ? 'aito.payment.dueQuote' : 'aito.payment.dueInvoice')}
        </span>
        {due !== null && <span className="text-white font-medium">{formatMoney(due, document.currency)}</span>}
      </div>

      <StateLine
        state={state}
        document={document}
        copied={copied}
        canUpdate={canUpdate}
        onCopy={copyLink}
        onReopenTerminal={() => setOpen('terminal')}
      />

      {showCells && (
        <div className={ACTION_GROUP}>
          <button
            type="button"
            onClick={() => setOpen('link')}
            disabled={!enabled}
            aria-label={t('aito.payment.cellLinkTitle')}
            title={t('aito.payment.cellLinkTitle')}
            className={`${ACTION_CELL} gap-1.5 text-xs`}
          >
            <Link2 className="w-3.5 h-3.5" aria-hidden="true" />
            {t('aito.payment.cellLink')}
          </button>
          <button
            type="button"
            onClick={() => setOpen('terminal')}
            disabled={!enabled || !heimdallConfigured}
            aria-label={t('aito.payment.cellTerminalTitle')}
            title={heimdallConfigured ? t('aito.payment.cellTerminalTitle') : t('aito.payment.terminalOff')}
            className={`${ACTION_CELL} gap-1.5 text-xs`}
          >
            <Smartphone className="w-3.5 h-3.5" aria-hidden="true" />
            {t('aito.payment.cellTerminal')}
          </button>
          <button
            type="button"
            onClick={() => setOpen('manual')}
            disabled={!enabled}
            aria-label={t('aito.payment.cellManualTitle')}
            title={t('aito.payment.cellManualTitle')}
            className={`${ACTION_CELL} gap-1.5 text-xs`}
          >
            <Banknote className="w-3.5 h-3.5" aria-hidden="true" />
            {t('aito.payment.cellManual')}
          </button>
        </div>
      )}

      {open === 'link' && (
        <PaymentLinkModal project={project} document={document} link={link} onClose={() => setOpen(null)} />
      )}
      {open === 'terminal' && (
        <TerminalPaymentModal project={project} document={document} initialPayment={openTerminal} onClose={() => setOpen(null)} />
      )}
      {open === 'manual' && (
        <ManualPaymentModal project={project} document={document} onClose={() => setOpen(null)} />
      )}
    </div>
  );
}

/** The one-line state a document's payment is in right now (spec §3.2). A
 *  child component in its own right — it calls `useTranslation` itself and
 *  takes only what it cannot derive (the state, the document, the copy
 *  flash and the two callbacks) as props. */
function StateLine({
  state,
  document,
  copied,
  canUpdate,
  onCopy,
  onReopenTerminal,
}: {
  state: PaymentState;
  document: PaymentDocument;
  copied: ReturnType<typeof useCopiedFlash>[0];
  canUpdate: boolean;
  onCopy: (url: string) => void;
  onReopenTerminal: () => void;
}) {
  const { t, i18n } = useTranslation();

  switch (state.kind) {
    case 'terminal_processing': {
      const line = (
        <span className="inline-flex items-center gap-1.5 text-bambu-gray">
          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
          {t('aito.payment.stateProcessing')}
        </span>
      );
      // A read-only viewer must never be offered a way back into the modal
      // (it is the only way to reach the terminal flow's controls), so
      // without `canUpdate` this is plain text instead of a button.
      return canUpdate ? (
        <button type="button" onClick={onReopenTerminal} className="text-left w-full">
          {line}
        </button>
      ) : (
        line
      );
    }

    case 'terminal_attention':
      return (
        <span className="inline-flex items-center gap-1.5 text-status-warning">
          <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
          {t('aito.payment.stateAttention')}
        </span>
      );

    case 'link_pending': {
      const link = state.link;
      const expiry = expiryText(t, link.expires_on, i18n.language);
      return (
        <div data-testid="payment-link-row" data-state={link.state}>
          <div className="flex items-center justify-between gap-x-3">
            <span className="text-bambu-gray">{t('aito.paymentLink.label')}</span>
            <span className="inline-flex items-center justify-end gap-x-2 min-w-0">
              {copied ? (
                <CopiedLabel phase={copied} text={t('aito.paymentLink.copied')} testId="payment-link-copied" />
              ) : (
                <span className="text-xs text-bambu-gray" title={expiry.title}>
                  {expiry.text}
                </span>
              )}
              {link.url && (
                <span className="inline-flex items-center gap-0.5 -my-1 -mr-1.5">
                  <OpenLinkButton href={link.url} label={t('aito.paymentLink.open')} />
                  <button
                    type="button"
                    onClick={() => onCopy(link.url as string)}
                    aria-label={t('aito.paymentLink.copy')}
                    title={copied ? t('aito.paymentLink.copied') : t('aito.paymentLink.copy')}
                    className={LINK_ICON_BUTTON_CLS}
                  >
                    {copied ? (
                      <Check className={`${LINK_ICON_CLS} text-bambu-green animate-tick-in`} aria-hidden="true" />
                    ) : (
                      <Copy className={LINK_ICON_CLS} aria-hidden="true" />
                    )}
                  </button>
                </span>
              )}
            </span>
          </div>
        </div>
      );
    }

    case 'paid': {
      const amount = formatMoney(state.amount, document.currency);
      const channel = t(state.channel === 'terminal' ? 'aito.payment.channelTerminal' : 'aito.payment.channelLink');
      const at = parseUTCDate(state.at);
      const line = at
        ? t('aito.payment.statePaid', { amount, channel, date: at.toLocaleDateString(i18n.language, { day: 'numeric', month: 'short' }) })
        : t('aito.payment.statePaidNoDate', { amount, channel });
      return (
        <div>
          <span className="inline-flex items-center gap-1.5 text-bambu-green">
            <Check className="w-3.5 h-3.5" aria-hidden="true" />
            {line}
          </span>
          {state.bookingFailed && (
            <span className="block text-xs text-bambu-gray mt-0.5">{t('aito.payment.stateBookingFailed')}</span>
          )}
        </div>
      );
    }

    case 'link_dead':
      return <span className="text-bambu-gray">{t(`aito.paymentLink.state.${state.link.state}`)}</span>;

    case 'none':
      return document.kind === 'invoice' ? <span className="text-bambu-gray">{t('aito.payment.stateNoLink')}</span> : null;

    default:
      return null;
  }
}
