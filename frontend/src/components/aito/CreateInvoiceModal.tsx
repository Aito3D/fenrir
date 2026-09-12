import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Card, CardContent } from '../Card';
import { Button } from '../Button';
import { api } from '../../api/client';
import { useDismissableDialog } from '../../hooks/useDismissableDialog';
import { useCreateInvoiceMutation } from '../../hooks/useCreateInvoiceMutation';
import { Money } from '../calculator/shared';

/** A beat past .animate-modal-out's 150ms, same margin SendInvoiceModal gives it. */
const MODAL_OUT_MS = 170;

/** Confirm raising the real invoice, and say exactly what it will do.
 *
 *  The confirmation is not ceremony. This is the one Aito action nothing in
 *  this app can undo: it puts a real document in the client's account, spends
 *  their deposits against it, and locks the quote to further line edits. So
 *  the dialog states the total being billed, every deposit that will be
 *  applied, and what will still be owed afterwards — the three facts an
 *  operator would otherwise have to open Books to check.
 *
 *  A retainer that can NOT be applied is listed too, struck through rather
 *  than omitted. A deposit missing from this list reads as "there was no
 *  deposit", which is precisely the misreading that gets a client billed
 *  twice for the same money.
 */
export function CreateInvoiceModal({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const { t } = useTranslation();
  // The success close rides `requestClose`, not `onClose`: the dialog leaves
  // the way it entered whether dismissed or done. The arrow defers the read
  // past this line — `requestClose` is declared below.
  const mutation = useCreateInvoiceMutation(projectId, () => requestClose());
  const { closing, requestClose, dialogRef } = useDismissableDialog(onClose, {
    animationMs: MODAL_OUT_MS,
    // While the invoice is being raised the dialog is spoken for: Escape must
    // not tear it down mid-request and leave the operator unsure whether a
    // real document was created.
    onEscape: (close) => {
      if (!mutation.isPending) close();
    },
  });

  const { data, isPending, isError, error } = useQuery({
    queryKey: ['aito-invoice-preview', projectId],
    queryFn: () => api.getAitoInvoicePreview(projectId),
    // Books' current truth, and the dialog is short-lived. A preview cached
    // from an hour ago could promise a deposit already spent since.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const currency = data?.currency_code || '';

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
        aria-label={t('aito.createInvoiceTitle')}
        tabIndex={-1}
        className={`w-full max-w-md max-h-[90vh] flex flex-col focus:outline-none ${
          closing ? 'animate-modal-out' : 'animate-modal-in'
        }`}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <CardContent className="p-6 flex flex-col min-h-0">
          <h3 className="text-lg font-semibold text-white mb-4">{t('aito.createInvoiceTitle')}</h3>

          <div className="overflow-y-auto flex-1 min-h-0">
            {isPending && (
              <div className="flex items-center gap-2 text-bambu-gray text-sm py-6">
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('common.loading')}
              </div>
            )}

            {/* The server's own message, not a generic one: every refusal here
                is a specific, actionable state (still syncing, already
                invoiced, not in Finish) and flattening them into "failed"
                would send the operator looking in the wrong place. */}
            {isError && (
              <p className="text-status-error text-sm py-6">
                {error instanceof Error && error.message ? error.message : t('aito.createInvoiceLoadFailed')}
              </p>
            )}

            {data && (
              // animate-rise: this replaces the loader (the query is never
              // cached — staleTime/gcTime 0), so it always mounts fresh.
              <div className="animate-rise">
                <p className="text-sm text-bambu-gray">
                  {t('aito.createInvoiceIntro', { quote: data.quote_number, count: data.line_count })}
                </p>

                <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm items-baseline">
                  <dt className="text-bambu-gray">{t('aito.createInvoiceAmount')}</dt>
                  <dd className="text-right text-white">
                    <Money value={data.total} currency={currency} />
                  </dd>

                  {data.retainers.map((retainer) => (
                    <div key={retainer.id || retainer.number} className="contents">
                      <dt className="text-bambu-gray min-w-0 truncate">{retainer.number}</dt>
                      <dd
                        className={`text-right ${
                          retainer.applicable > 0 ? 'text-bambu-green' : 'text-bambu-gray line-through'
                        }`}
                      >
                        {/* The applicable figure when there is one, the
                            retainer's own total when there is not — a
                            struck-through "0" says nothing about how much
                            deposit is sitting there unpaid. */}
                        <Money
                          value={retainer.applicable > 0 ? -retainer.applicable : retainer.total}
                          currency={currency}
                        />
                      </dd>
                    </div>
                  ))}

                  <dt className="text-bambu-gray border-t border-bambu-dark-tertiary pt-1">
                    {t('aito.createInvoiceRemaining')}
                  </dt>
                  <dd className="text-right text-white border-t border-bambu-dark-tertiary pt-1">
                    <Money value={data.projected_balance} currency={currency} />
                  </dd>
                </dl>

                {/* Named rather than left to be discovered: after this, the
                    quote stops accepting line edits from this app. */}
                <p className="mt-4 text-xs text-bambu-gray">{t('aito.createInvoiceLockWarning')}</p>
              </div>
            )}
          </div>

          <div className="flex gap-3 mt-6">
            <Button variant="secondary" onClick={requestClose} className="flex-1" disabled={mutation.isPending}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => mutation.mutate()} className="flex-1" disabled={!data || mutation.isPending}>
              {mutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {t('aito.createInvoiceConfirm')}
                </>
              ) : (
                t('aito.createInvoiceConfirm')
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
