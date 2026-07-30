import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Send, ThumbsDown, ThumbsUp } from 'lucide-react';
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
 *  The block disappears entirely once the quote is ACCEPTED or DECLINED.
 *  Acceptance authorises the work and a decline ends it; past either, the
 *  quote is settled, and a correction belongs in Books rather than in a button
 *  sitting next to a job on the board. The accepted consequence is that
 *  re-accepting a declined quote has to happen in Books — both actions are
 *  hold-to-confirm, so intent is proven before the state becomes terminal.
 *
 *  Mark-as-sent renders only while the client does not yet have the quote
 *  (null or draft). This REPLACES an earlier rule that kept every action
 *  visible-but-disabled with a check mark, and kept mark-as-sent live on
 *  viewed/expired for re-sending: an action already taken is now simply not
 *  offered, and nothing in this block is ever disabled-by-status. */
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
  // quote settles and the block goes away.
  if (project.quote_status === 'accepted' || project.quote_status === 'declined') return null;

  // Mark-as-sent only while the client does not have the quote yet. On sent,
  // viewed and expired they already do, so offering to mark it sent says
  // nothing true.
  const canMarkSent = project.quote_status === null || project.quote_status === 'draft';

  return (
    <div className="flex flex-col gap-2 border-t border-bambu-dark-tertiary pt-4">
      {canMarkSent && (
        <HoldButton
          onHold={() => mutation.mutate('sent')}
          durationMs={500}
          disabled={mutation.isPending}
          label={t('aito.markSent')}
          hint={t('aito.holdToConfirm')}
          className="justify-center border p-1.5 border-amber-400/40 text-amber-400 hover:bg-amber-400/10"
        >
          <Send className="w-3.5 h-3.5" />
          <span className="text-sm">{t('aito.markSent')}</span>
        </HoldButton>
      )}
      <div className="flex items-center gap-2">
      <HoldButton
        onHold={() => mutation.mutate('accepted')}
        durationMs={500}
        disabled={mutation.isPending}
        label={t('aito.acceptQuote')}
        hint={t('aito.holdToConfirm')}
        className="flex-1 justify-center border p-1.5 border-bambu-green/40 text-bambu-green hover:bg-bambu-green/10"
      >
        <ThumbsUp className="w-3.5 h-3.5" />
        <span className="text-sm">{t('aito.acceptQuote')}</span>
      </HoldButton>
      <HoldButton
        onHold={() => mutation.mutate('declined')}
        durationMs={500}
        disabled={mutation.isPending}
        label={t('aito.declineQuote')}
        hint={t('aito.holdToConfirm')}
        className="flex-1 justify-center border p-1.5 border-status-error/40 text-status-error hover:bg-status-error/10"
      >
        <ThumbsDown className="w-3.5 h-3.5" />
        <span className="text-sm">{t('aito.declineQuote')}</span>
      </HoldButton>
      </div>
    </div>
  );
}
