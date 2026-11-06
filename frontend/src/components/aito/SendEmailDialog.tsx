import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Card, CardContent } from '../Card';
import { Button } from '../Button';
import { inputCls, labelCls } from '../formStyles';
import type { AitoInvoiceEmailContent } from '../../api/client';
import { useDismissableDialog } from '../../hooks/useDismissableDialog';
import { ZohoEmailPreview } from './ZohoEmailPreview';

/** A beat past .animate-modal-out's 150ms, same margin the drawers give
 *  drawer-out (200ms → 220). */
const MODAL_OUT_MS = 170;

/** What Books would email for a document: the fields every document's prefill shares. */
export type EmailContent = Pick<AitoInvoiceEmailContent, 'subject' | 'body' | 'recipients' | 'default_email'>;

/** Pick an address and email a Zoho Books document: the dialog itself, whichever
 *  document and endpoints its caller brings (an Aito card's invoice or retainer,
 *  an order's invoice).
 *
 *  Single-select with no free-text entry, because the server validates `to`
 *  against the addresses Books offers for the document and the UI must not
 *  offer what the API will refuse.
 */
export function SendEmailDialog({
  title,
  loadFailed,
  content: { data, isPending, isError },
  onSend,
  contactPersonId = null,
  onClose,
}: {
  title: string;
  /** Shown when the prefill could not be read. */
  loadFailed: string;
  /** The prefill query. Never cached by the callers: Books' current truth. */
  content: { data?: EmailContent; isPending: boolean; isError: boolean };
  /** Sends to the chosen address. The dialog closes when it resolves and stays
   *  open when it rejects, so the user can retry or pick another address; the
   *  caller words the failure. */
  onSend: (to: string) => Promise<unknown>;
  /** The card's contact person, when it has one: preferred over Books'
   *  default recipient. */
  contactPersonId?: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [to, setTo] = useState('');
  const [sending, setSending] = useState(false);
  const { closing, requestClose, dialogRef } = useDismissableDialog(onClose, {
    animationMs: MODAL_OUT_MS,
    // Same gate the backdrop has: while the send is in flight the modal is
    // spoken for, and Escape must not tear it down mid-request.
    onEscape: (close) => {
      if (!sending) close();
    },
  });
  // The success close rides `requestClose`, not `onClose`: the modal leaves
  // the way it entered (animate-modal-out) whether dismissed or done.
  const send = () => {
    setSending(true);
    onSend(to)
      .then(requestClose, () => {})
      .finally(() => setSending(false));
  };

  // Seed the selection once the prefill lands. The card's contact person
  // wins when Books lists them; otherwise Books' own default. Guarded on
  // `to` still being empty so a refetch cannot silently reset a choice
  // already made.
  useEffect(() => {
    if (!data || to) return;
    const own = contactPersonId
      ? data.recipients.find((r) => r.contact_person_id === contactPersonId)
      : undefined;
    const seed = own?.email || data.default_email;
    if (seed) setTo(seed);
  }, [data, to, contactPersonId]);

  const recipients = data?.recipients ?? [];

  return (
    // z-[110], not z-50: ProjectDetailPanel's own backdrop is z-50, so a lower
    // overlay renders behind the panel that opened this.
    // pointer-events-none while closing: the modal is already spoken for, and
    // a click landing here mid-exit would re-enter the close path.
    <div
      className={`fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-[110] ${
        closing ? 'animate-overlay-out pointer-events-none' : 'animate-overlay-in'
      }`}
      onClick={sending ? undefined : requestClose}
    >
      <Card
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        // max-w-2xl, not max-w-md: Books' templates are built on fixed-width
        // tables that re-wrap into nonsense in a narrower frame.
        // max-h-[90vh] + flex flex-col: the preview can be up to 26rem tall,
        // so on short viewports the card must cap its own height and let the
        // content scroll internally rather than pushing the Send/Cancel row
        // off-screen.
        className={`w-full max-w-2xl max-h-[90vh] flex flex-col focus:outline-none ${
          closing ? 'animate-modal-out' : 'animate-modal-in'
        }`}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <CardContent className="p-6 flex flex-col min-h-0">
          <h3 className="text-lg font-semibold text-white mb-4">{title}</h3>

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
              <p className="text-status-error text-sm py-6">
                {loadFailed}
              </p>
            )}

            {data && (
              // animate-rise: this content replaces the loader (the query is
              // never cached — staleTime/gcTime 0), so it always mounts fresh
              // and needs the bridge — same as ImportQuoteDrawer's preview.
              <div className="animate-rise">
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
                    disabled={sending}
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
              </div>
            )}
          </div>

          <div className="flex gap-3 mt-6">
            <Button
              variant="secondary"
              onClick={requestClose}
              className="flex-1"
              disabled={sending}
            >
              {t('common.cancel')}
            </Button>
            <Button
              onClick={send}
              className="flex-1"
              disabled={!to || sending}
            >
              {sending ? (
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
