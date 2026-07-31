import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type AitoProject } from '../api/client';
import { useToast } from '../contexts/ToastContext';

// Module scope: a plain object literal, identical on every render, so it
// need not be reconstructed each time a consumer renders.
const TOAST_KEYS = {
  sent: 'aito.quoteSent',
  accepted: 'aito.quoteAccepted',
  declined: 'aito.quoteDeclined',
} as const;

/** The one quote-status transition, shared by the detail panel's action block
 *  and the board card's mark-as-sent button.
 *
 *  Extracted rather than duplicated because the two surfaces must agree on
 *  more than the request: the optimistic cache write, which toast fires, and
 *  the separate warning when the board moved but the push to Books did not.
 *  A second copy would drift on the third of those first. */
export function useQuoteStatusMutation(project: AitoProject) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: (status: 'sent' | 'accepted' | 'declined') => api.setAitoQuoteStatus(project.id, { status }),
    onSuccess: (result, status) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        prev?.map((p) => (p.id === result.project.id ? result.project : p)) ?? prev,
      );
      queryClient.invalidateQueries({ queryKey: ['aito-events', project.id] });
      showToast(t(TOAST_KEYS[status]), 'success');
      // The board is right either way — only the push to Books failed.
      if (project.quote_id && !result.zoho_synced) showToast(t('aito.zohoNotUpdated'), 'error');
    },
    onError: () => showToast(t('aito.saveFailed'), 'error'),
  });
}
