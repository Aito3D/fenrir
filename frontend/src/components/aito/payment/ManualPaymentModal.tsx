import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Card, CardContent } from '../../Card';
import { Button } from '../../Button';
import { api } from '../../../api/client';
import type { AitoManualPaymentMode, AitoProject } from '../../../api/client';
import { useDismissableDialog } from '../../../hooks/useDismissableDialog';
import { useToast } from '../../../contexts/ToastContext';
import { labelCls, inputCls } from '../../formStyles';
import { ACTION_CELL, ACTION_GROUP } from '../quoteActionGroup';
import { AmountField } from './AmountField';
import { parseAmount } from './amount';
import type { PaymentDocument } from './paymentDocument';

/** A beat past .animate-modal-out's 150ms, same margin CreateInvoiceModal gives it. */
const MODAL_OUT_MS = 170;
const MODES: AitoManualPaymentMode[] = ['card', 'cheque', 'cash'];

/** Record a payment taken at the counter (card/cheque/cash) against a quote's
 *  deposit or an invoice's balance. On a quote this creates a retainer
 *  invoice in Zoho Books and records the payment on it; on an invoice it
 *  records the payment directly. */
export function ManualPaymentModal({ project, document, onClose }: {
  project: AitoProject;
  document: PaymentDocument;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<AitoManualPaymentMode>('card');
  const [amount, setAmount] = useState(document.due !== null ? String(document.due) : '');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (body: { mode: AitoManualPaymentMode; amount: number; reference: string | null }) =>
      api.recordAitoManualPayment(project.id, { document_kind: document.kind, document_id: document.id, ...body }),
    onSuccess: (fresh) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (rows) => rows?.map((r) => (r.id === fresh.id ? fresh : r)));
      queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
      queryClient.invalidateQueries({ queryKey: ['aito-invoice', project.id] });
      queryClient.invalidateQueries({ queryKey: ['aito-events', project.id] });
      showToast(t('aito.payment.manualDone'), 'success');
      requestClose();
    },
    onError: (e: unknown) => setError(e instanceof Error && e.message ? e.message : t('common.errorLoading')),
  });
  const { closing, requestClose, dialogRef } = useDismissableDialog(onClose, {
    animationMs: MODAL_OUT_MS,
    // While the payment is being recorded the dialog is spoken for: Escape
    // must not tear it down mid-request and leave the operator unsure
    // whether the payment landed.
    onEscape: (close) => {
      if (!mutation.isPending) close();
    },
  });

  const submit = () => {
    setError(null);
    const parsed = parseAmount(amount);
    if (parsed === null) {
      setError(t('aito.payment.amountInvalid'));
      return;
    }
    const ref = reference.trim();
    if (mode === 'cheque' && !ref) {
      setError(t('aito.payment.referenceRequired'));
      return;
    }
    mutation.mutate({ mode, amount: parsed, reference: ref || null });
  };

  return (
    // z-[110], not z-50: ProjectDetailPanel's own backdrop is z-50, so a lower
    // overlay renders behind the panel that opened this.
    <div
      className={`fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-[110] ${
        closing ? 'animate-overlay-out pointer-events-none' : 'animate-overlay-in'
      }`}
      onClick={mutation.isPending ? undefined : requestClose}
    >
      <Card
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('aito.payment.manualTitle')}
        tabIndex={-1}
        className={`w-full max-w-md max-h-[90vh] flex flex-col focus:outline-none ${
          closing ? 'animate-modal-out' : 'animate-modal-in'
        }`}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <CardContent className="p-6 flex flex-col min-h-0">
          <h3 className="text-lg font-semibold text-white mb-1">{t('aito.payment.manualTitle')}</h3>
          <p className="text-sm text-bambu-gray mb-4">
            {t(document.kind === 'quote' ? 'aito.payment.manualIntroQuote' : 'aito.payment.manualIntroInvoice', { number: document.number })}
          </p>

          <div className="space-y-4">
            <div>
              <span className={labelCls} id="manual-mode-label">{t('aito.payment.modeLabel')}</span>
              <div className={`${ACTION_GROUP} mt-0`} role="radiogroup" aria-labelledby="manual-mode-label">
                {MODES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={mode === m}
                    onClick={() => setMode(m)}
                    className={`${ACTION_CELL} text-sm ${mode === m ? 'bg-bambu-green/15 text-bambu-green' : ''}`}
                  >
                    {t(`aito.payment.mode${m[0].toUpperCase()}${m.slice(1)}`)}
                  </button>
                ))}
              </div>
            </div>

            <AmountField
              id="manual-amount"
              value={amount}
              onChange={setAmount}
              currency={document.currency}
              label={t('aito.payment.amountLabel')}
            />

            <div>
              <label htmlFor="manual-reference" className={labelCls}>{t('aito.payment.referenceLabel')}</label>
              <input
                id="manual-reference"
                type="text"
                maxLength={64}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                className={inputCls}
              />
            </div>

            <p className="text-xs text-bambu-gray">
              {t(document.kind === 'quote' ? 'aito.payment.manualHintQuote' : 'aito.payment.manualHintInvoice')}
            </p>

            {error && <p className="text-status-error text-sm" role="alert">{error}</p>}
          </div>

          <div className="flex gap-3 mt-6">
            <Button variant="secondary" onClick={requestClose} className="flex-1" disabled={mutation.isPending}>
              {t('common.cancel')}
            </Button>
            <Button onClick={submit} className="flex-1" disabled={mutation.isPending}>
              {mutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {t('aito.payment.manualConfirm')}
                </>
              ) : (
                t('aito.payment.manualConfirm')
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
