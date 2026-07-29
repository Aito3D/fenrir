import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Send, ThumbsDown, ThumbsUp } from 'lucide-react';
import { HoldButton } from './HoldButton';
import { api, type AitoProject } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';

// Module scope: a plain object literal, identical on every render, so it
// need not be reconstructed each time the panel renders.
const TOAST_KEYS = {
  sent: 'aito.quoteSent',
  accepted: 'aito.quoteAccepted',
  declined: 'aito.quoteDeclined',
} as const;

/** Move this project's quote to sent, accepted or declined.
 *
 *  Each one moves the card: sent parks it in Waiting, acceptance releases it
 *  onto the work columns, a decline sends it to Done. So all three are
 *  hold-to-confirm, like delete. 500 ms rather than delete's 1000: these are
 *  reversible (accepting a declined quote reopens it), so the gesture only has
 *  to prove intent, not discourage.
 *
 *  Once the quote is ACCEPTED the whole block disappears: acceptance is the
 *  gate that authorises the work, and past it the quote is settled — the card
 *  is on the work columns and its steps drive it from there. Un-sending or
 *  declining accepted work is a correction to make in Books, not a button to
 *  leave sitting next to a job in progress.
 *
 *  Before that, whichever action matches the current status is disabled rather
 *  than hidden: a control that vanishes reads as a bug, and its check mark is
 *  how the panel says where the quote already stands. Mark-as-sent stays live
 *  on a `viewed` or `expired` quote — those are Zoho's words for what happened
 *  next, not a different decision, and re-sending is a real thing to do. */
export function QuoteStatusActions({ project }: { project: AitoProject }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const mutation = useMutation({
    mutationFn: (status: 'sent' | 'accepted' | 'declined') => api.setAitoQuoteStatus(project.id, { status }),
    onSuccess: (result, status) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        prev?.map((p) => (p.id === result.project.id ? result.project : p)) ?? prev,
      );
      showToast(t(TOAST_KEYS[status]), 'success');
      // The board is right either way — only the push to Books failed.
      if (project.quote_id && !result.zoho_synced) showToast(t('aito.zohoNotUpdated'), 'error');
    },
    onError: () => showToast(t('aito.saveFailed'), 'error'),
  });

  // After every hook, so the hook order is identical on the render where the
  // quote flips to accepted and the block goes away.
  if (project.quote_status === 'accepted') return null;

  const isSent = project.quote_status === 'sent';
  const isDeclined = project.quote_status === 'declined';

  return (
    <div className="flex flex-col gap-2 border-t border-bambu-dark-tertiary pt-4">
      <HoldButton
        onHold={() => mutation.mutate('sent')}
        durationMs={500}
        disabled={isSent || mutation.isPending}
        label={t('aito.markSent')}
        hint={t('aito.holdToConfirm')}
        className="justify-center border p-1.5 border-amber-400/40 text-amber-400 hover:bg-amber-400/10"
      >
        {isSent ? <Check className="w-3.5 h-3.5" /> : <Send className="w-3.5 h-3.5" />}
        <span className="text-sm">{t('aito.markSent')}</span>
      </HoldButton>
      <div className="flex items-center gap-2">
      <HoldButton
        onHold={() => mutation.mutate('accepted')}
        durationMs={500}
        disabled={mutation.isPending}
        label={t('aito.acceptQuote')}
        hint={t('aito.holdToConfirm')}
        className="flex-1 justify-center border p-1.5 border-bambu-green/40 text-bambu-green hover:bg-bambu-green/10"
      >
        {/* Never a check mark: an accepted quote renders no block at all. */}
        <ThumbsUp className="w-3.5 h-3.5" />
        <span className="text-sm">{t('aito.acceptQuote')}</span>
      </HoldButton>
      <HoldButton
        onHold={() => mutation.mutate('declined')}
        durationMs={500}
        disabled={isDeclined || mutation.isPending}
        label={t('aito.declineQuote')}
        hint={t('aito.holdToConfirm')}
        className="flex-1 justify-center border p-1.5 border-status-error/40 text-status-error hover:bg-status-error/10"
      >
        {isDeclined ? <Check className="w-3.5 h-3.5" /> : <ThumbsDown className="w-3.5 h-3.5" />}
        <span className="text-sm">{t('aito.declineQuote')}</span>
      </HoldButton>
      </div>
    </div>
  );
}
