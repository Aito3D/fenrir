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
import { LINK_ICON_BUTTON_CLS, LINK_ICON_CLS, useCopiedFlash } from './linkActionHelpers';
import { CopiedLabel, OpenLinkButton } from './linkActions';

/** One row in the Quote card: the online payment link's state, Open / Copy
 *  buttons while the link is live, a check once it was paid, and the last
 *  Heimdall error with a Retry. Renders nothing without a link — a hand-made
 *  card, or a quote the reconciler has not reached yet.
 *
 *  The buttons share `linkActions.tsx` with the Record card's tracking row,
 *  one card down: same glyph size, same tone, same order (open, then copy),
 *  same rising "Copied". The row is a flex line rather than the card's
 *  `<dl>` grid so that, like the tracking row, it can wrap the confirmation
 *  under itself on a narrow rail instead of squeezing the amount. */
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
  const [copied, flashCopied] = useCopiedFlash();
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
      flashCopied();
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
  const live = (link.state === 'pending' || link.state === 'paid') && !!link.url;

  return (
    <div className="mt-2 text-sm" data-testid="payment-link-row" data-state={link.state}>
      <div className="flex items-center justify-between gap-x-3">
        <span className="text-bambu-gray">{t('aito.paymentLink.label')}</span>
        <span className="inline-flex items-center justify-end gap-x-2 min-w-0">
          {/* While the confirmation shows it stands IN for the amount rather
              than beside it: the row is too narrow for "5 000 FCFP", two
              buttons and "Copied" on one line, and wrapping the amount under
              the label for a second and a half reads as a glitch. Same
              position as the tracking row's confirmation — immediately left
              of the buttons. */}
          {copied ? (
            <CopiedLabel phase={copied} text={t('aito.paymentLink.copied')} testId="payment-link-copied" />
          ) : link.state === 'paid' ? (
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
          {live && link.url && (
            <span className="inline-flex items-center gap-0.5 -my-1 -mr-1.5">
              {/* -my-1 -mr-1.5 pulls the buttons' own padding off the line
                  and the card's right edge, so the glyphs sit flush with the
                  values above — same offset the tracking row uses. */}
              <OpenLinkButton href={link.url} label={t('aito.paymentLink.open')} />
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
            </span>
          )}
        </span>
      </div>
      {link.state === 'pending' && (
        <span className="block text-right text-xs text-bambu-gray" title={expiresDate}>
          {expiresText}
        </span>
      )}
      {moved && needed !== null && (
        <span className="block text-right text-xs text-status-error">
          {t('aito.paymentLink.totalMoved', { paid: amount, quote: formatMoney(needed, link.currency) })}
        </span>
      )}
      {link.sync_error && (
        <span className="block text-right text-xs text-bambu-gray">
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
    </div>
  );
}
