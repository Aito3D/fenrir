import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Card, CardContent } from '../Card';
import { Button } from '../Button';
import { inputCls, labelCls } from '../formStyles';
import { api, type AitoProject } from '../../api/client';
import { useSendQuoteMutation } from '../../hooks/useSendQuoteMutation';
import { QuoteEmailPreview } from './QuoteEmailPreview';

/** Pick an address and email this project's quote through Zoho Books.
 *
 *  Single-select with no free-text entry: the server validates `to` against
 *  the addresses Books offers for this estimate, and the UI must not offer
 *  what the API will refuse. Widening the sources later widens `recipients`
 *  server-side and this dropdown grows with it.
 */
export function SendQuoteModal({
  project,
  onClose,
}: {
  project: AitoProject;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [to, setTo] = useState('');
  const mutation = useSendQuoteMutation(project, onClose);

  const { data, isPending, isError } = useQuery({
    queryKey: ['aito-quote-email', project.id],
    queryFn: () => api.getAitoQuoteEmail(project.id),
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
        className="w-full max-w-2xl animate-modal-in"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <CardContent className="p-6">
          <h3 className="text-lg font-semibold text-white mb-4">{t('aito.sendQuoteTitle')}</h3>

          {isPending && (
            <div className="flex items-center gap-2 text-bambu-gray text-sm py-6">
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('common.loading')}
            </div>
          )}

          {isError && (
            <p className="text-status-error text-sm py-6">{t('aito.sendQuoteLoadFailed')}</p>
          )}

          {data && (
            <>
              <label className={labelCls} htmlFor="send-quote-recipient">
                {t('aito.sendQuoteRecipient')}
              </label>
              {recipients.length === 0 ? (
                <p className="text-bambu-gray text-sm">{t('aito.sendQuoteNoRecipients')}</p>
              ) : (
                <select
                  id="send-quote-recipient"
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
                <span className={labelCls}>{t('aito.sendQuoteSubject')}</span>
                <p className="text-white text-sm">{data.subject}</p>
              </div>

              <div className="mt-4">
                <span className={labelCls}>{t('aito.sendQuoteMessage')}</span>
                <QuoteEmailPreview html={data.body} />
              </div>
            </>
          )}

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
                  {t('aito.sendQuoteConfirm')}
                </>
              ) : (
                t('aito.sendQuoteConfirm')
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
