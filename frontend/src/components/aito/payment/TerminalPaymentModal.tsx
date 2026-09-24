import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Loader2, X } from 'lucide-react';
import { Card, CardContent } from '../../Card';
import { Button } from '../../Button';
import { api } from '../../../api/client';
import type { AitoProject, AitoTerminalPayment } from '../../../api/client';
import { useDismissableDialog } from '../../../hooks/useDismissableDialog';
import { formatMoney } from '../../../utils/pricing';
import { AmountField } from './AmountField';
import { parseAmount } from './amount';
import type { PaymentDocument } from './paymentDocument';
import { isTerminalOpen, useTerminalPayment } from './useTerminalPayment';

const MODAL_OUT_MS = 170;

/** Card payment taken at the counter terminal: form → waiting → paid / failed
 *  / needs-attention (spec §3.4). `initialPayment` lets the payment block
 *  reopen this modal on a charge already in flight — it opens straight on
 *  the waiting screen, which has no cancel button because closing the modal
 *  never stops the charge. */
export function TerminalPaymentModal({ project, document, initialPayment, onClose }: {
  project: AitoProject;
  document: PaymentDocument;
  initialPayment: AitoTerminalPayment | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState(document.due !== null ? String(document.due) : '');
  const [error, setError] = useState<string | null>(null);
  const [paymentId, setPaymentId] = useState<number | null>(initialPayment?.id ?? null);
  const poll = useTerminalPayment(project.id, paymentId, initialPayment);
  const payment = paymentId === null ? null : (poll.data ?? initialPayment);
  const start = useMutation({
    mutationFn: (value: number) =>
      api.startAitoTerminalPayment(project.id, { document_kind: document.kind, document_id: document.id, amount: value }),
    onSuccess: (row) => {
      setError(null);
      queryClient.setQueryData(['aito-terminal-payment', project.id, row.id], row);
      setPaymentId(row.id);
    },
    onError: (e: unknown) => setError(e instanceof Error && e.message ? e.message : t('common.errorLoading')),
  });
  const { closing, requestClose, dialogRef } = useDismissableDialog(onClose, {
    animationMs: MODAL_OUT_MS,
    onEscape: (close) => {
      if (!start.isPending) close();
    },
  });

  // Every settled read seeds the board row so the block's state line moves
  // without waiting for the next board fetch. Bail out early while there is
  // no payment yet, or while it is still open and not yet paid (nothing to
  // seed); once it is paid or otherwise settled, write it into the board
  // cache, and once it is no longer open at all, also invalidate the queries
  // that depend on it.
  useEffect(() => {
    const stillOpenAndUnpaid = isTerminalOpen(payment) && payment?.status !== 'paid';
    if (!payment || stillOpenAndUnpaid) return;
    queryClient.setQueryData<AitoProject[]>(['aito-projects'], (rows) =>
      rows?.map((r) => (r.id === project.id ? { ...r, terminal_payment: payment } : r)));
    if (!isTerminalOpen(payment)) {
      queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
      queryClient.invalidateQueries({ queryKey: ['aito-invoice', project.id] });
      queryClient.invalidateQueries({ queryKey: ['aito-events', project.id] });
    }
  }, [payment, project.id, queryClient]);

  const submit = () => {
    const parsed = parseAmount(amount);
    if (parsed === null) {
      setError(t('aito.payment.amountInvalid'));
      return;
    }
    setError(null);
    start.mutate(parsed);
  };
  const retry = () => {
    setPaymentId(null);
    setError(null);
  };
  const shown = payment ? formatMoney(payment.amount_confirmed ?? payment.amount, document.currency) : '';

  let body: React.ReactNode;
  let footer: React.ReactNode;
  if (!payment) {
    body = (
      <div className="space-y-4">
        <AmountField id="terminal-amount" value={amount} onChange={setAmount} currency={document.currency} label={t('aito.payment.amountLabel')} />
        <p className="text-xs text-bambu-gray">
          {t(document.kind === 'quote' ? 'aito.payment.terminalHintQuote' : 'aito.payment.terminalHintInvoice')}
        </p>
        {error && <p className="text-status-error text-sm" role="alert">{error}</p>}
      </div>
    );
    footer = (
      <>
        <Button variant="secondary" onClick={requestClose} className="flex-1" disabled={start.isPending}>
          {t('common.cancel')}
        </Button>
        <Button onClick={submit} className="flex-1" disabled={start.isPending}>
          {start.isPending ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              {t('aito.payment.terminalStart')}
            </>
          ) : (
            t('aito.payment.terminalStart')
          )}
        </Button>
      </>
    );
  } else if (payment.status === 'pending' || payment.status === 'processing') {
    body = (
      <div className="flex flex-col items-center gap-2 py-4 text-center">
        <Loader2 className="w-7 h-7 animate-spin text-bambu-green" aria-hidden="true" />
        <p className="text-2xl font-semibold text-white">{shown}</p>
        {/* Two <p>s, not one with a <br />: RTL's text matcher concatenates
            a single element's text nodes with no separator, which breaks an
            exact match on just the first line. */}
        <div className="text-sm text-bambu-gray space-y-0.5">
          <p>{t('aito.payment.terminalWaiting')}</p>
          <p>{t('aito.payment.terminalWaitingHint')}</p>
        </div>
        {payment.sync_error && <p className="text-xs text-status-warning">{payment.sync_error}</p>}
      </div>
    );
    footer = <Button variant="secondary" onClick={requestClose} className="flex-1">{t('aito.payment.terminalLeave')}</Button>;
  } else if (payment.status === 'paid') {
    const booking =
      payment.booking_status === 'booked'
        ? 'terminalBookingDone'
        : payment.booking_status === 'failed'
          ? 'terminalBookingFailed'
          : 'terminalBookingPending';
    body = (
      <div className="flex flex-col items-center gap-2 py-4 text-center">
        <span className="w-11 h-11 rounded-full bg-bambu-green/15 text-bambu-green flex items-center justify-center">
          <Check className="w-6 h-6" aria-hidden="true" />
        </span>
        <p className="text-2xl font-semibold text-bambu-green">{shown}</p>
        <p className="text-sm text-white">{t('aito.payment.terminalPaid')}</p>
        <p className={`text-xs ${payment.booking_status === 'failed' ? 'text-status-warning' : 'text-bambu-gray'}`}>
          {t(`aito.payment.${booking}`)}
        </p>
      </div>
    );
    footer = <Button onClick={requestClose} className="flex-1">{t('common.close')}</Button>;
  } else if (payment.status === 'needs_attention') {
    body = (
      <div className="flex flex-col items-center gap-2 py-4 text-center">
        <span className="w-11 h-11 rounded-full bg-status-warning/15 text-status-warning flex items-center justify-center">
          <AlertTriangle className="w-6 h-6" aria-hidden="true" />
        </span>
        <p className="text-2xl font-semibold text-status-warning">{t('aito.payment.terminalAttention')}</p>
        <p className="text-sm text-bambu-gray">{t('aito.payment.terminalAttentionHint')}</p>
      </div>
    );
    footer = <Button variant="secondary" onClick={requestClose} className="flex-1">{t('common.close')}</Button>;
  } else {
    body = (
      <div className="flex flex-col items-center gap-2 py-4 text-center">
        <span className="w-11 h-11 rounded-full bg-status-error/15 text-status-error flex items-center justify-center">
          <X className="w-6 h-6" aria-hidden="true" />
        </span>
        <p className="text-2xl font-semibold text-status-error">{t('aito.payment.terminalFailed')}</p>
        <p className="text-sm text-bambu-gray">{t('aito.payment.terminalFailedHint')}</p>
        {payment.sync_error && <p className="text-xs text-bambu-gray">{payment.sync_error}</p>}
      </div>
    );
    footer = (
      <>
        <Button variant="secondary" onClick={requestClose} className="flex-1">{t('common.close')}</Button>
        <Button onClick={retry} className="flex-1">{t('aito.payment.terminalRetry')}</Button>
      </>
    );
  }

  return (
    // z-[110], not z-50: ProjectDetailPanel's own backdrop is z-50, so a lower
    // overlay renders behind the panel that opened this.
    <div
      className={`fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-[110] ${
        closing ? 'animate-overlay-out pointer-events-none' : 'animate-overlay-in'
      }`}
      onClick={start.isPending ? undefined : requestClose}
    >
      <Card
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('aito.payment.terminalTitle')}
        tabIndex={-1}
        className={`w-full max-w-md max-h-[90vh] flex flex-col focus:outline-none ${
          closing ? 'animate-modal-out' : 'animate-modal-in'
        }`}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <CardContent className="p-6 flex flex-col min-h-0">
          <h3 className="text-lg font-semibold text-white mb-1">{t('aito.payment.terminalTitle')}</h3>
          <p className="text-sm text-bambu-gray mb-4">{t('aito.payment.terminalIntro', { number: document.number })}</p>
          {body}
          <div className="flex gap-3 mt-6">{footer}</div>
        </CardContent>
      </Card>
    </div>
  );
}
