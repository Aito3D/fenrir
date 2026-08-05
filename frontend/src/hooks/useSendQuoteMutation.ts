import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type AitoProject } from '../api/client';
import { useToast } from '../contexts/ToastContext';

/** Email this project's quote, then adopt whatever the server did to the card.
 *
 *  Deliberately a plain `useMutation` rather than `useOptimisticBoardMutation`,
 *  which every other board write uses. Those predict the move because the
 *  decision is already made locally and Zoho is best-effort. Here the email IS
 *  the act: predicting the card into Waiting before Books confirms would show
 *  the shop a quote sent that never left. So the cache is written only from
 *  the server's own row, on success.
 */
export function useSendQuoteMutation(project: AitoProject, onDone: () => void) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: (to: string) => api.sendAitoQuoteEmail(project.id, { to }),
    onSuccess: (result, to) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        prev?.map((p) => (p.id === result.project.id ? result.project : p)) ?? prev,
      );
      queryClient.invalidateQueries({ queryKey: ['aito-events', project.id] });
      showToast(t('aito.quoteEmailed', { email: to }), 'success');
      onDone();
    },
    // No rollback to undo — nothing was written. The modal stays open so the
    // user can retry or pick another address without rebuilding the selection.
    onError: () => showToast(t('aito.quoteEmailFailed'), 'error'),
  });
}
