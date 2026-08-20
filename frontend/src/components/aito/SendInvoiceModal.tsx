import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Card, CardContent } from '../Card';
import { Button } from '../Button';
import { inputCls, labelCls } from '../formStyles';
import { api } from '../../api/client';
import { useSendInvoiceMutation } from '../../hooks/useSendInvoiceMutation';
import { ZohoEmailPreview } from './ZohoEmailPreview';

/** Pick an address and email this project's invoice through Zoho Books.
 *
 *  The Send-quote modal's twin, and deliberately identical in shape: the two
 *  open from cards one above the other and must not read as two different
 *  kinds of dialog. Single-select with no free-text entry, because the
 *  server validates `to` against the addresses Books offers for this invoice
 *  and the UI must not offer what the API will refuse.
 *
 *  Takes ids rather than the project row: unlike a quote, whose id lives on
 *  the project, the invoice is only known once InvoiceCard's query has
 *  answered — and pinning to THAT invoice is the point (see `invoiceId`).
 */
export function SendInvoiceModal({
  projectId,
  /** The invoice the card is displaying. The card renders from a cache while
   *  the endpoint resolves live, so "whatever is newest" could email a
   *  document whose number the operator never saw. The server still owns the
   *  candidate set; this only says which of them. */
  invoiceId,
  onClose,
}: {
  projectId: number;
  invoiceId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [to, setTo] = useState('');
  const mutation = useSendInvoiceMutation(projectId, invoiceId, onClose);

  const { data, isPending, isError } = useQuery({
    queryKey: ['aito-invoice-email', projectId, invoiceId],
    queryFn: () => api.getAitoInvoiceEmail(projectId, invoiceId),
    // Books' current truth, and the modal is short-lived: a list cached from
    // an hour ago could offer an address Books has since removed, which the
    // send would then reject.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  // Seed the selection once the prefill lands. Guarded on `to` still being
  // empty so a refetch cannot silently reset a choice already made.
  useEffect(() => {
    if (data?.default_email && !to) setTo(data.default_email);
  }, [data, to]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !mutation.isPending) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, mutation.isPending]);

  const recipients = data?.recipients ?? [];

  return (
    // z-[110], not z-50: ProjectDetailPanel's own backdrop is z-50, so a lower
    // overlay renders behind the panel that opened this.
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 animate-overlay-in z-[110]"
      onClick={mutation.isPending ? undefined : onClose}
    >
      <Card
        // max-w-2xl, not max-w-md: Books' templates are built on fixed-width
        // tables that re-wrap into nonsense in a narrower frame.
        // max-h-[90vh] + flex flex-col: the preview can be up to 26rem tall,
        // so on short viewports the card must cap its own height and let the
        // content scroll internally rather than pushing the Send/Cancel row
        // off-screen.
        className="w-full max-w-2xl max-h-[90vh] flex flex-col animate-modal-in"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <CardContent className="p-6 flex flex-col min-h-0">
          <h3 className="text-lg font-semibold text-white mb-4">{t('aito.sendInvoiceTitle')}</h3>

          {/* Scrollable content region: everything except the button row, so
              the row below stays reachable even when the preview pushes the
              card past the viewport height. */}
          <div className="overflow-y-auto flex-1 min-h-0">
            {isPending && (
              <div className="flex items-center gap-2 text-bambu-gray text-sm py-6">
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('common.loading')}
              </div>
            )}

            {isError && (
              <p className="text-status-error text-sm py-6">{t('aito.sendInvoiceLoadFailed')}</p>
            )}

            {data && (
              <>
                <label className={labelCls} htmlFor="send-invoice-recipient">
                  {t('aito.sendInvoiceRecipient')}
                </label>
                {recipients.length === 0 ? (
                  <p className="text-bambu-gray text-sm">{t('aito.sendInvoiceNoRecipients')}</p>
                ) : (
                  <select
                    id="send-invoice-recipient"
                    className={inputCls}
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    disabled={mutation.isPending}
                  >
                    {recipients.map((r) => (
                      <option key={r.email} value={r.email}>
                        {r.name ? `${r.name} — ${r.email}` : r.email}
                      </option>
                    ))}
                  </select>
                )}

                <div className="mt-4">
                  <span className={labelCls}>{t('aito.sendInvoiceSubject')}</span>
                  <p className="text-white text-sm">{data.subject}</p>
                </div>

                <div className="mt-4">
                  <span id="send-invoice-message-label" className={labelCls}>
                    {t('aito.sendInvoiceMessage')}
                  </span>
                  <ZohoEmailPreview html={data.body} labelledBy="send-invoice-message-label" />
                </div>
              </>
            )}
          </div>

          <div className="flex gap-3 mt-6">
            <Button
              variant="secondary"
              onClick={onClose}
              className="flex-1"
              disabled={mutation.isPending}
            >
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => mutation.mutate(to)}
              className="flex-1"
              disabled={!to || mutation.isPending}
            >
              {mutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {t('aito.sendInvoiceConfirm')}
                </>
              ) : (
                t('aito.sendInvoiceConfirm')
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
