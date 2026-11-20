import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Banknote, Link2, Smartphone } from 'lucide-react';
import { ApiError, api } from '../../api/client';
import type { AitoTerminalPayment, OrderPayment, OrderPaymentLink } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { copyTextToClipboard } from '../../utils/clipboard';
import { useCopiedFlash } from '../aito/linkActionHelpers';
import { ACTION_CELL, ACTION_GROUP } from '../aito/quoteActionGroup';
import { ManualPaymentModal } from '../aito/payment/ManualPaymentModal';
import { StateLine } from '../aito/payment/PaymentBlock';
import { PaymentLinkDialog } from '../aito/payment/PaymentLinkModal';
import { TerminalPaymentDialog } from '../aito/payment/TerminalPaymentModal';
import { isTerminalOpen } from '../aito/payment/useTerminalPayment';
import type { PaymentDocument } from '../aito/payment/paymentDocument';
import { blockVisible, derivePaymentState } from '../aito/payment/paymentState';
import { formatMoney } from '../../utils/pricing';

/** The collect block of one order, in the shape of the Aito card's: what is left to pay, the one-line state of a
 *  link or a charge in motion, then the three ways to collect. `total` replaces the order total while an edit is
 *  open: what is left (or the credit left over) follows it. With `orderId` (the caller holds orders:update) it
 *  collects on the document the server picks. Renders nothing when nothing is left and nothing is in motion. */
export function OrderPaymentBlock({ payment, currency, total, orderId }: { payment: OrderPayment; currency: string; total?: number; orderId?: string }) {
  const left = total === undefined ? payment.left : Math.round((total - payment.paid) * 100) / 100;
  return orderId ? <Collect orderId={orderId} currency={currency} left={left} boardLeft={payment.left} /> : <Due left={left} currency={currency} labelKey="orders.pay.left" />;
}

/** The head line: "Balance due 12 000", or the credit an edit leaves over. Nothing at exactly zero. */
function Due({ left, currency, labelKey }: { left: number; currency: string; labelKey: string }) {
  const { t } = useTranslation();
  if (left === 0) return null;
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-bambu-gray">{left > 0 ? t(labelKey) : ''}</span>
      <span data-testid="pay-left" className="font-medium text-white">
        {left > 0 ? formatMoney(left, currency) : t('orders.edit.creditLeft', { amount: formatMoney(-left, currency) })}
      </span>
    </div>
  );
}

/** The order's collect block on the document the server picks (the newest invoice with a balance, else the quote's
 *  open retainer, else the quote or the sales order itself): link, terminal and manual (cheque, cash, card
 *  elsewhere), prefilled with what is left to pay, capped at that document's balance. */
function Collect({ orderId, currency, left, boardLeft }: { orderId: string; currency: string; left: number; boardLeft: number }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [copied, flashCopied] = useCopiedFlash();
  // `boardLeft` in the key: a payment that lands on the board re-reads the target. The previous answer stays while
  // it loads, so an open dialog is never unmounted by the payment it just took.
  const target = useQuery({
    queryKey: ['order-payment-target', orderId, boardLeft],
    queryFn: () => api.getOrderPaymentTarget(orderId),
    placeholderData: keepPreviousData,
  });
  // The order's newest charge, for the state line; polled only while one is in flight.
  const charge = useQuery({
    queryKey: ['order-terminal-current', orderId, boardLeft],
    queryFn: () => api.getOrderTerminalPayment(orderId),
    refetchInterval: q => (isTerminalOpen(q.state.data) ? 3000 : false),
    retry: false,
  });
  // What a dialog opened on, kept here so a payment that empties the target never unmounts the dialog showing it.
  const [open, setOpen] = useState<{ document: PaymentDocument; hint?: string; link?: OrderPaymentLink | null; terminal?: AitoTerminalPayment | null; manual?: true } | null>(null);
  const [opening, setOpening] = useState(false);
  const data = target.data;
  const due = data?.max_amount == null ? 0 : Math.min(Math.max(0, Math.round(data.left)), data.max_amount);
  // The dialogs only tell a quote deposit from the rest; the server charges its own target whatever this says.
  const document: PaymentDocument | null =
    data?.kind && data.document_id && data.max_amount !== null
      ? { kind: 'invoice', id: data.document_id, number: data.number ?? '', due: due > 0 ? due : null, currency }
      : null;
  // A retainer is not an invoice balance, and a quote payment becomes a new retainer: each has its own hint.
  const hint = data?.kind === 'retainer' ? t('orders.pay.retainerHint') : data?.kind === 'quote' ? t('orders.pay.quoteHint') : data?.kind === 'salesorder' ? t('orders.pay.orderHint') : undefined;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['order-payment-target', orderId] });
    void queryClient.invalidateQueries({ queryKey: ['order-terminal-current', orderId] });
    void queryClient.invalidateQueries({ queryKey: ['order-board'], exact: true });
    void queryClient.invalidateQueries({ queryKey: ['order-board', 'finished'], exact: true });
    void queryClient.invalidateQueries({ queryKey: ['order-board-finished-order', orderId] });
    void queryClient.invalidateQueries({ queryKey: ['order-events', orderId] });
  };
  const openTerminal = async (doc: PaymentDocument) => {
    setOpening(true);
    // A charge still in flight reopens on its waiting screen rather than offering a second one.
    let current: AitoTerminalPayment | null;
    try {
      current = await api.getOrderTerminalPayment(orderId);
    } catch {
      // The lookup failed: never offer a second charge over one that may still be waiting on the terminal.
      current = charge.data ?? null;
      if (!isTerminalOpen(current)) {
        setOpening(false);
        showToast(t('common.errorLoading'), 'error');
        return;
      }
    }
    setOpening(false);
    setOpen({ document: doc, hint, terminal: isTerminalOpen(current) ? current : null });
  };
  const state = derivePaymentState(data?.link ?? null, charge.data ?? null);
  // "Balance due" once an invoice carries the debt, "Left to pay" on the order before that.
  const invoiced = data?.kind === 'invoice';
  const lineDocument: PaymentDocument = { kind: invoiced ? 'invoice' : 'quote', id: data?.document_id ?? '', number: data?.number ?? '', due, currency };
  const copyLink = async (url: string) => {
    if (await copyTextToClipboard(url)) flashCopied();
    else showToast(t('common.errorLoading'), 'error');
  };
  if (left === 0 && !open && !blockVisible(null, state)) return null;
  const busy = state.kind === 'terminal_processing';
  return (
    <div data-testid="payment-block" data-state={state.kind} className="text-sm">
      <Due left={left} currency={currency} labelKey={invoiced ? 'aito.payment.dueInvoice' : 'orders.pay.left'} />
      <StateLine
        state={state}
        document={lineDocument}
        copied={copied}
        canUpdate={!!document}
        onCopy={url => void copyLink(url)}
        onReopenTerminal={() => document && void openTerminal(document)}
        onManageLink={() => document && setOpen({ document, hint, link: data?.link ?? null })}
      />
      {document && (
        <div className={ACTION_GROUP}>
          {/* A live link is the state line above (open, copy, manage): the row offers the two other channels. */}
          {state.kind !== 'link_pending' && (
            <button type="button" disabled={busy} className={`${ACTION_CELL} gap-1.5 text-xs`} onClick={() => setOpen({ document, hint, link: data?.link ?? null })} aria-label={t('aito.payment.cellLinkTitle')} title={t('aito.payment.cellLinkTitle')}>
              <Link2 aria-hidden="true" className="h-3.5 w-3.5" />
              {t('aito.payment.cellLink')}
            </button>
          )}
          <button type="button" className={`${ACTION_CELL} gap-1.5 text-xs`} onClick={() => void openTerminal(document)} disabled={opening} aria-label={t('aito.payment.cellTerminalTitle')} title={t('aito.payment.cellTerminalTitle')}>
            <Smartphone aria-hidden="true" className="h-3.5 w-3.5" />
            {t('aito.payment.cellTerminal')}
          </button>
          <button type="button" disabled={busy} className={`${ACTION_CELL} gap-1.5 text-xs`} onClick={() => setOpen({ document, hint, manual: true })} aria-label={t('aito.payment.cellManualTitle')} title={t('aito.payment.cellManualTitle')}>
            <Banknote aria-hidden="true" className="h-3.5 w-3.5" />
            {t('aito.payment.cellManual')}
          </button>
        </div>
      )}
      {open?.manual && (
        <ManualPaymentModal
          document={open.document}
          hint={open.hint}
          onClose={() => setOpen(null)}
          onRecord={async (body) => {
            await api.recordOrderManualPayment(orderId, body);
            refresh();
          }}
        />
      )}
      {open && !open.manual && open.terminal === undefined && (
        <PaymentLinkDialog
          document={open.document}
          hint={open.hint}
          link={open.link ?? null}
          onClose={() => setOpen(null)}
          onCreate={async (amount) => {
            const link = await api.createOrderPaymentLink(orderId, amount);
            void queryClient.invalidateQueries({ queryKey: ['order-payment-target', orderId] });
            void queryClient.invalidateQueries({ queryKey: ['order-events', orderId] });
            return link;
          }}
          onCancel={async () => {
            await api.cancelOrderPaymentLink(orderId);
            refresh();
          }}
        />
      )}
      {open && open.terminal !== undefined && (
        <TerminalPaymentDialog
          document={open.document}
          hint={open.hint}
          initialPayment={open.terminal}
          onClose={() => setOpen(null)}
          pollKey={['order-terminal-payment', orderId]}
          onStart={(amount) => api.startOrderTerminalPayment(orderId, amount)}
          // An open payment link could take the same money twice: the server refuses until it is cancelled.
          recover={(e) =>
            e instanceof ApiError && e.code === 'link_open'
              ? {
                  message: t('orders.pay.linkOpen'),
                  label: t('orders.pay.cancelLinkAndCharge'),
                  start: async (amount) => {
                    const row = await api.startOrderTerminalPayment(orderId, amount, true);
                    refresh();
                    return row;
                  },
                }
              : null
          }
          fetchPayment={async () => {
            const row = await api.getOrderTerminalPayment(orderId);
            if (!row) throw new Error(t('common.errorLoading'));
            return row;
          }}
          onSeen={(payment) => {
            if (!isTerminalOpen(payment)) refresh();
          }}
        />
      )}
    </div>
  );
}
