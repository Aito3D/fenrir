import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { errorReason, failedStepText, isRefused } from './orderErrors';
import type { OrderHandoverOutcome } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';

/** The words of a hand-over or an invoice call: what the answer says, or why the call failed. */
export function useOrderOutcomeToasts() {
  const { t } = useTranslation();
  const { showToast } = useToast();

  return {
    /** A thrown error: Zoho busy, the order moved under the operator, or Books' own message. */
    failed: (e: unknown) => {
      const reason = errorReason(t, e);
      showToast(isRefused(e) || (e instanceof ApiError && e.status === 503) ? reason : t('orders.handover.failed', { reason }), 'error');
    },
    /** An answered outcome; `mode` is set for a hand-over, absent for an invoice on its own. */
    outcome: (o: OrderHandoverOutcome, mode?: 'pickup' | 'delivery') => {
      if (o.failed_step) {
        showToast(failedStepText(t, o), 'warning');
      } else if (o.invoice === 'manual') {
        showToast(o.manual_reason === 'draft' ? t('orders.handover.manualDraft', { number: o.invoice_number ?? '' }) : t('orders.handover.manual'), 'warning');
      }
      // An invoice asked for on its own that found nothing to invoice would otherwise say nothing.
      if (!mode && !o.failed_step && o.invoice === 'none') showToast(t('orders.inv.nothing'), 'info');
      const parts: string[] = [];
      if (mode && o.failed_step !== 'delivered') parts.push(t(mode === 'pickup' ? 'orders.handover.donePickup' : 'orders.handover.doneDelivery', { number: o.package_number }));
      if (o.invoice === 'created') parts.push(t('orders.handover.invoiceCreated', { number: o.invoice_number ?? '' }));
      if (parts.length) showToast(parts.join(' · '));
    },
  };
}
