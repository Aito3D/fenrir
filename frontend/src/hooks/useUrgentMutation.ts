import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useOptimisticBoardMutation } from './useOptimisticBoardMutation';
import { api, type AitoProject } from '../api/client';
import { useToast } from '../contexts/ToastContext';

/** Flag a project urgent, or clear it.
 *
 *  The optimistic transform only flips the boolean — it does NOT reorder.
 *  `buildBoard` sorts urgent-first on every render, so flipping the flag is
 *  enough to move the card, and duplicating the sort here would be a second
 *  place to get the comparator wrong. */
export function useUrgentMutation(project: AitoProject) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  return useOptimisticBoardMutation<AitoProject, boolean>({
    mutationFn: (urgent) => api.setAitoProjectUrgent(project.id, urgent),
    transform: (previous, urgent) =>
      previous?.map((p) => (p.id === project.id ? { ...p, urgent } : p)),
    flashId: () => project.id,
    onSuccess: (row) => {
      // The server's row over the prediction, like every sibling writer: it
      // carries the real `updated_at` and the recomputed derived fields.
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        prev?.map((p) => (p.id === row.id ? row : p)) ?? prev,
      );
      queryClient.invalidateQueries({ queryKey: ['aito-events', project.id] });
    },
    onError: () => showToast(t('aito.flagFailed'), 'error'),
  });
}
