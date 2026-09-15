import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Copy } from 'lucide-react';
import { api } from '../../api/client';
import type { AitoProject } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { copyTextToClipboard } from '../../utils/clipboard';
import { formatMoney } from '../../utils/pricing';
import { localDateKey, parseLocalDateKey } from '../../utils/date';
import { requiredAmount } from '../../utils/aitoPayment';

/** One row in the Quote card: the online payment link's state, a Copy
 *  button while it can still be paid, a check once it was, and the last
 *  Heimdall error with a Retry. Renders nothing without a link — a hand-made
 *  card, or a quote the reconciler has not reached yet. */
export function PaymentLinkRow({
  project,
  canUpdate,
  depositPct = 0,
}: {
  project: AitoProject;
  canUpdate: boolean;
  depositPct?: number;
}) {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  // Same recipe as TrackingLinkControl's `copiedTimers`: keep the pending
  // timeout's id so a second copy within the 2s window clears the first
  // rather than racing it, and so unmounting mid-window (closing the panel
  // right after a copy) doesn't call setState on a gone component.
  const copiedTimer = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    };
  }, []);
  const link = project.payment_link;

  const refresh = useMutation({
    mutationFn: () => api.refreshAitoPaymentLink(project.id),
    onSuccess: (fresh) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (rows) =>
        rows?.map((r) => (r.id === fresh.id ? fresh : r)),
      );
      queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
    },
    onError: () => showToast(t('common.errorLoading'), 'error'),
  });

  if (!link) return null;

  const copy = async () => {
    if (!link.url) return;
    if (await copyTextToClipboard(link.url)) {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      setCopied(true);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 2000);
    } else {
      showToast(t('common.errorLoading'), 'error');
    }
  };

  const amount = formatMoney(link.amount, link.currency);
  const expiresOn = parseLocalDateKey(link.expires_on);
  const expiresDate = expiresOn.toLocaleDateString(i18n.language, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  // Whole calendar days from local midnight today to the expiry date, so a link
  // expiring tomorrow reads "1 day" all day long regardless of the current hour.
  const daysLeft = Math.round(
    (expiresOn.getTime() - parseLocalDateKey(localDateKey(new Date())).getTime()) / 86_400_000,
  );
  const expiresText =
    daysLeft > 0
      ? t('aito.paymentLink.expiresIn', { count: daysLeft })
      : daysLeft === 0
        ? t('aito.paymentLink.expiresToday')
        : t('aito.paymentLink.state.expired');
  const needed = requiredAmount(project.quote_total, depositPct, project.retainer_paid_total);
  const moved = link.state === 'paid' && needed !== null && needed !== link.amount;

  return (
    <dl
      className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm items-baseline"
      data-testid="payment-link-row"
      data-state={link.state}
    >
      <dt className="text-bambu-gray">{t('aito.paymentLink.label')}</dt>
      <dd className="text-right min-w-0">
        {link.state === 'paid' ? (
          <span data-testid="payment-link-paid" className="inline-flex items-center gap-1 text-bambu-green">
            <Check className="w-3.5 h-3.5" aria-hidden="true" />
            {t('aito.paymentLink.paid')} <span data-testid="payment-link-amount">{amount}</span>
          </span>
        ) : link.state === 'pending' ? (
          <span data-testid="payment-link-amount" className="text-white">
            {amount}
          </span>
        ) : (
          <span className="text-bambu-gray">{t(`aito.paymentLink.state.${link.state}`)}</span>
        )}
        {(link.state === 'pending' || link.state === 'paid') && link.url && (
          <button
            type="button"
            onClick={copy}
            aria-label={t('aito.paymentLink.copy')}
            title={t('aito.paymentLink.copy')}
            className="ml-2 inline-flex items-center gap-1 align-middle text-xs text-bambu-green hover:text-bambu-green/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40 rounded"
          >
            {copied ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
            {copied ? t('aito.paymentLink.copied') : t('aito.paymentLink.copyShort')}
          </button>
        )}
        {link.state === 'pending' && (
          <span className="block text-xs text-bambu-gray" title={expiresDate}>
            {expiresText}
          </span>
        )}
        {moved && needed !== null && (
          <span className="block text-xs text-status-error">
            {t('aito.paymentLink.totalMoved', { paid: amount, quote: formatMoney(needed, link.currency) })}
          </span>
        )}
        {link.sync_error && (
          <span className="block text-xs text-bambu-gray">
            {link.sync_error}
            {canUpdate && (
              <button
                type="button"
                onClick={() => refresh.mutate()}
                disabled={refresh.isPending}
                className="block ml-auto mt-1 text-xs text-bambu-green hover:text-bambu-green/80 disabled:opacity-50"
              >
                {t('aito.paymentLink.retry')}
              </button>
            )}
          </span>
        )}
      </dd>
    </dl>
  );
}
