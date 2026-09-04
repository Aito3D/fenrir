import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useOptimisticBoardMutation } from './useOptimisticBoardMutation';
import { api, type AitoFlag, type AitoProject } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { settleProject } from '../components/aito/settleProject';

/** Set a project's board flag, or clear it.
 *
 *  The optimistic transform only writes the field — it does NOT reorder.
 *  `buildBoard` applies the three-tier flag rank on every render, so writing
 *  the field is enough to move the card, and duplicating the comparator here
 *  would be a second place to get it wrong. */
export function useFlagMutation(project: AitoProject) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  return useOptimisticBoardMutation<AitoProject, AitoFlag | null>({
    mutationFn: (flag) => api.setAitoProjectFlag(project.id, flag),
    transform: (previous, flag) =>
      previous?.map((p) => (p.id === project.id ? { ...p, flag } : p)),
    flashId: () => project.id,
    // The server's row over the prediction, like every sibling writer: it
    // carries the real `updated_at` and the recomputed derived fields.
    onSuccess: (row) => settleProject(queryClient, project.id, row),
    onError: () => showToast(t('aito.flagFailed'), 'error'),
  });
}
