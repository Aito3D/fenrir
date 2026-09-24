import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Loader2 } from 'lucide-react';
import { Card, CardContent } from '../../Card';
import { Button } from '../../Button';
import { api } from '../../../api/client';
import type { AitoPaymentLink, AitoProject } from '../../../api/client';
import { useDismissableDialog } from '../../../hooks/useDismissableDialog';
import { useToast } from '../../../contexts/ToastContext';
import { copyTextToClipboard } from '../../../utils/clipboard';
import { formatMoney } from '../../../utils/pricing';
import { inputCls } from '../../formStyles';
import { LINK_ICON_BUTTON_CLS, LINK_ICON_CLS, useCopiedFlash } from '../linkActionHelpers';
import { CopiedLabel, OpenLinkButton } from '../linkActions';
import { AmountField } from './AmountField';
import { parseAmount } from './amount';
import type { PaymentDocument } from './paymentDocument';
import { expiryText } from './paymentState';

/** A beat past .animate-modal-out's 150ms, same margin CreateInvoiceModal gives it. */
const MODAL_OUT_MS = 170;

/** Spec §3.2's `link_pending` condition: a minted link with a URL, not yet
 *  paid or dead. Kept local rather than importing `derivePaymentState` —
 *  this modal only ever cares about the link, never the terminal charge. */
function isLiveLink(link: AitoPaymentLink | null): link is AitoPaymentLink & { url: string } {
  return !!link && link.state === 'pending' && link.minted && !!link.url;
}

/** Create, view or cancel the online payment link for a quote's deposit or
 *  an invoice's balance (spec §3.4). Three views: a live link (open / copy /
 *  cancel), an invoice with no live link (a form that creates one), or a
 *  quote with no live link — read-only, since the reconciler is the only
 *  thing that mints a quote's link. */
export function PaymentLinkModal({ project, document, link, onClose }: {
  project: AitoProject;
  document: PaymentDocument;
  link: AitoPaymentLink | null;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [copied, flashCopied] = useCopiedFlash();
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [amount, setAmount] = useState(document.due !== null ? String(document.due) : '');
  const [error, setError] = useState<string | null>(null);

  const settle = (fresh: AitoProject, toastKey: string) => {
    queryClient.setQueryData<AitoProject[]>(['aito-projects'], (rows) => rows?.map((r) => (r.id === fresh.id ? fresh : r)));
    queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
    queryClient.invalidateQueries({ queryKey: ['aito-events', project.id] });
    showToast(t(toastKey), 'success');
    requestClose();
  };

  const create = useMutation({
    mutationFn: (value: number) => api.createAitoInvoicePaymentLink(project.id, { document_id: document.id, amount: value }),
    onSuccess: (fresh) => settle(fresh, 'aito.payment.linkDone'),
    onError: (e: unknown) => setError(e instanceof Error && e.message ? e.message : t('common.errorLoading')),
  });

  const cancel = useMutation({
    // `link` is only null here if the caller opened the modal without one —
    // the cancel button never renders in that case, so this mutation never
    // fires without a live link's id.
    mutationFn: () => api.cancelAitoPaymentLink(project.id, (link as AitoPaymentLink).id),
    onSuccess: (fresh) => settle(fresh, 'aito.payment.linkCancelled'),
    onError: (e: unknown) => setError(e instanceof Error && e.message ? e.message : t('common.errorLoading')),
  });

  const pending = create.isPending || cancel.isPending;
  const { closing, requestClose, dialogRef } = useDismissableDialog(onClose, {
    animationMs: MODAL_OUT_MS,
    // While a create/cancel request is in flight the dialog is spoken for:
    // Escape must not tear it down mid-request.
    onEscape: (close) => {
      if (!pending) close();
    },
  });

  const copy = async () => {
    if (!link?.url) return;
    if (await copyTextToClipboard(link.url)) {
      flashCopied();
    } else {
      showToast(t('common.errorLoading'), 'error');
    }
  };

  const submitCreate = () => {
    setError(null);
    const parsed = parseAmount(amount);
    if (parsed === null) {
      setError(t('aito.payment.amountInvalid'));
      return;
    }
    create.mutate(parsed);
  };

  const clickCancel = () => {
    if (!confirmingCancel) {
      setConfirmingCancel(true);
      return;
    }
    setError(null);
    cancel.mutate();
  };

  const live = isLiveLink(link) ? link : null;

  let body: React.ReactNode;
  let footer: React.ReactNode;

  if (live) {
    const expiry = expiryText(t, live.expires_on, i18n.language);
    body = (
      <div className="space-y-4">
        <div className="flex items-center gap-1">
          <div className={`${inputCls} truncate text-xs`}>{live.url}</div>
          <OpenLinkButton href={live.url} label={t('aito.paymentLink.open')} />
          <button
            type="button"
            onClick={copy}
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
        </div>
        {copied && (
          <div className="flex justify-end -mt-2">
            <CopiedLabel phase={copied} text={t('aito.paymentLink.copied')} testId="payment-link-modal-copied" />
          </div>
        )}
        <dl className="space-y-1 text-sm">
          <div className="flex items-center justify-between">
            <dt className="text-bambu-gray">{t('aito.payment.amountLabel')}</dt>
            <dd className="text-white">{formatMoney(live.amount, live.currency)}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-bambu-gray">{t('aito.payment.linkExpires')}</dt>
            <dd className="text-white" title={expiry.title}>{expiry.text}</dd>
          </div>
        </dl>
        {error && <p className="text-status-error text-sm" role="alert">{error}</p>}
      </div>
    );
    footer =
      document.kind === 'invoice' ? (
        <>
          <Button variant="secondary" onClick={clickCancel} className="flex-1" disabled={pending}>
            {cancel.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {t(confirmingCancel ? 'aito.payment.linkCancelConfirm' : 'aito.payment.linkCancel')}
              </>
            ) : (
              t(confirmingCancel ? 'aito.payment.linkCancelConfirm' : 'aito.payment.linkCancel')
            )}
          </Button>
          <Button onClick={requestClose} className="flex-1" disabled={pending}>
            {t('common.close')}
          </Button>
        </>
      ) : (
        <Button onClick={requestClose} className="flex-1">
          {t('common.close')}
        </Button>
      );
  } else if (document.kind === 'invoice') {
    // A `pending` link that isn't `live` is a reservation whose Heimdall
    // create hasn't (yet) landed — never a dead link, since dead states are
    // paid/expired/failed/cancelled. Left alone (no `sync_error`), it is
    // still in flight: nothing to submit, just wait for the reconciler.
    // Once it has a `sync_error` the backend is expected to replay that same
    // stuck reservation under its own key on the next create, so the form
    // shows the plain "Create the link" label, not "again".
    const reservation = link && link.state === 'pending' ? link : null;
    if (reservation && !reservation.sync_error) {
      body = <p className="text-sm text-bambu-gray">{t('aito.payment.linkPending')}</p>;
      footer = (
        <Button onClick={requestClose} className="flex-1">
          {t('common.close')}
        </Button>
      );
    } else {
      // A non-null, non-reservation link here is dead (paid/expired/failed/
      // cancelled) — the create button reads "a new one" rather than "the
      // link" so it is clear the old one is gone for good.
      const dead = !!link && !reservation;
      body = (
        <div className="space-y-4">
          <AmountField id="link-amount" value={amount} onChange={setAmount} currency={document.currency} label={t('aito.payment.amountLabel')} />
          <p className="text-xs text-bambu-gray">{t('aito.payment.linkHintInvoice')}</p>
          {reservation?.sync_error && <p className="text-xs text-bambu-gray">{reservation.sync_error}</p>}
          {error && <p className="text-status-error text-sm" role="alert">{error}</p>}
        </div>
      );
      footer = (
        <>
          <Button variant="secondary" onClick={requestClose} className="flex-1" disabled={create.isPending}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submitCreate} className="flex-1" disabled={create.isPending}>
            {create.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {t(dead ? 'aito.payment.linkCreateAgain' : 'aito.payment.linkCreate')}
              </>
            ) : (
              t(dead ? 'aito.payment.linkCreateAgain' : 'aito.payment.linkCreate')
            )}
          </Button>
        </>
      );
    }
  } else {
    // A quote's link is only ever minted by the reconciler — nothing to
    // create or cancel here, just today's state. `aito.paymentLink.state`
    // only covers expired/cancelled/failed, so paid and pending-unminted
    // links need their own copy here rather than printing a raw key.
    let stateText: string;
    if (!link) {
      stateText = t('aito.payment.stateNoLink');
    } else if (link.state === 'paid') {
      stateText = `${t('aito.paymentLink.paid')} ${formatMoney(link.amount, link.currency)}`;
    } else if (link.state === 'pending') {
      stateText = t('aito.payment.linkPending');
    } else {
      stateText = t(`aito.paymentLink.state.${link.state}`);
    }
    body = <p className="text-sm text-bambu-gray">{stateText}</p>;
    footer = (
      <Button onClick={requestClose} className="flex-1">
        {t('common.close')}
      </Button>
    );
  }

  return (
    // z-[110], not z-50: ProjectDetailPanel's own backdrop is z-50, so a lower
    // overlay renders behind the panel that opened this.
    <div
      className={`fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-[110] ${
        closing ? 'animate-overlay-out pointer-events-none' : 'animate-overlay-in'
      }`}
      onClick={pending ? undefined : requestClose}
    >
      <Card
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('aito.payment.linkTitle')}
        tabIndex={-1}
        className={`w-full max-w-md max-h-[90vh] flex flex-col focus:outline-none ${
          closing ? 'animate-modal-out' : 'animate-modal-in'
        }`}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <CardContent className="p-6 flex flex-col min-h-0">
          <h3 className="text-lg font-semibold text-white mb-1">{t('aito.payment.linkTitle')}</h3>
          <p className="text-sm text-bambu-gray mb-4">{document.number}</p>
          {body}
          <div className="flex gap-3 mt-6">{footer}</div>
        </CardContent>
      </Card>
    </div>
  );
}
