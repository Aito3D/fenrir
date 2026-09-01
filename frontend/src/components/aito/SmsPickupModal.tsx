import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, RefreshCw, Send } from 'lucide-react';
import { Card, CardContent } from '../Card';
import { Button } from '../Button';
import { inputCls, labelCls } from '../formStyles';
import { api, type AitoProject } from '../../api/client';
import { useDismissableDialog } from '../../hooks/useDismissableDialog';
import { useToast } from '../../contexts/ToastContext';

/** A beat past .animate-modal-out's 150ms — same margin SendQuoteModal gives. */
const MODAL_OUT_MS = 170;

/** Draft, edit and relay the "come and collect your part" SMS.
 *
 *  The draft comes from the server's AI endpoint and lands in an EDITABLE
 *  textarea — what goes to the phone is whatever this box holds when Send is
 *  pressed, never the raw model answer. Send posts to Pushcut, which raises a
 *  notification on the user's iPhone; the SMS itself only leaves once they
 *  accept it there. That is also why sending here does not touch the
 *  contacted mark: the panel's ContactedControl stays the deliberate act it
 *  already is, made once the SMS truly went out.
 */
export function SmsPickupModal({
  project,
  onClose,
}: {
  project: AitoProject;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  // Tracks whether the user has taken over the textarea: a regenerate must
  // replace the draft they asked to replace, but a background refetch must
  // never stomp text they are mid-editing. Reset on each explicit regenerate.
  const [edited, setEdited] = useState(false);

  const draft = useQuery({
    queryKey: ['aito-pickup-message', project.id],
    queryFn: () => api.generateAitoPickupMessage(project.id),
    // Never cached: each open is a fresh paid call on purpose — the project
    // description may have changed, and a modal is short-lived.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  // Seed/replace the textarea from the draft unless the user owns it now.
  // Derived during render rather than an effect: the query result is the
  // only input, and an effect would flash the stale text for a frame.
  if (draft.data && !edited && message !== draft.data.message) {
    setMessage(draft.data.message);
  }

  const send = useMutation({
    mutationFn: () => api.sendAitoPickupSms(project.id, message.trim()),
    onSuccess: () => {
      showToast(t('aito.smsSent'), 'success');
      // The send wrote a timeline event; the open panel's rail must not show
      // a history missing the thing that just happened.
      queryClient.invalidateQueries({ queryKey: ['aito-events', project.id] });
      requestClose();
    },
    onError: () => showToast(t('aito.smsSendFailed'), 'error'),
  });

  const { closing, requestClose, dialogRef } = useDismissableDialog(onClose, {
    animationMs: MODAL_OUT_MS,
    // Same gate the backdrop has: while the send is in flight the modal is
    // spoken for, and Escape must not tear it down mid-request.
    onEscape: (close) => {
      if (!send.isPending) close();
    },
  });

  const regenerate = () => {
    setEdited(false);
    setMessage('');
    draft.refetch();
  };

  return (
    // z-[110], not z-50: ProjectDetailPanel's own backdrop is z-50, so a lower
    // overlay renders behind the panel that opened this — same as SendQuoteModal.
    <div
      className={`fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-[110] ${
        closing ? 'animate-overlay-out pointer-events-none' : 'animate-overlay-in'
      }`}
      onClick={send.isPending ? undefined : requestClose}
    >
      <Card
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('aito.smsTitle')}
        tabIndex={-1}
        className={`w-full max-w-lg focus:outline-none ${closing ? 'animate-modal-out' : 'animate-modal-in'}`}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <CardContent className="p-6">
          <h3 className="text-lg font-semibold text-white mb-1">{t('aito.smsTitle')}</h3>
          <p className="text-sm text-bambu-gray mb-4">
            {/* The recipient, stated where the sender can check it — the one
                fact a wrong tap on the phone cannot fix. */}
            {project.client_name ? `${project.client_name} · ` : ''}
            {project.client_phone}
          </p>

          {draft.isFetching && (
            <div className="flex items-center gap-2 text-bambu-gray text-sm py-6">
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('aito.smsGenerating')}
            </div>
          )}

          {draft.isError && !draft.isFetching && (
            <p className="text-status-error text-sm py-6">{t('aito.smsGenerateFailed')}</p>
          )}

          {!draft.isFetching && !draft.isError && (
            <div className="animate-rise">
              <label className={labelCls} htmlFor="sms-pickup-message">
                {t('aito.smsMessageLabel')}
              </label>
              <textarea
                id="sms-pickup-message"
                className={`${inputCls} min-h-28 resize-y`}
                value={message}
                maxLength={1000}
                onChange={(e) => {
                  setEdited(true);
                  setMessage(e.target.value);
                }}
                disabled={send.isPending}
              />
            </div>
          )}

          <div className="flex items-center justify-end gap-2 mt-4">
            <Button variant="ghost" size="sm" onClick={requestClose} disabled={send.isPending}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={regenerate}
              disabled={draft.isFetching || send.isPending}
            >
              <RefreshCw className="w-4 h-4" />
              {t('aito.smsRegenerate')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => send.mutate()}
              disabled={draft.isFetching || send.isPending || !message.trim()}
            >
              {send.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              {t('aito.smsSend')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
