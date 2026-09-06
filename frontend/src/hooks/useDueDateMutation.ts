import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useOptimisticBoardMutation } from './useOptimisticBoardMutation';
import { settleProject } from '../components/aito/settleProject';
import { api, type AitoProject } from '../api/client';
import { useToast } from '../contexts/ToastContext';

/** Set or clear a project's promised date. Writes only the field: `buildBoard`
 *  re-ranks overdue cards on every render, exactly as it does for flags. */
export function useDueDateMutation(project: AitoProject) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  return useOptimisticBoardMutation<AitoProject, string | null>({
    mutationFn: (dueDate) => api.setAitoProjectDueDate(project.id, dueDate),
    transform: (previous, dueDate) =>
      previous?.map((p) => (p.id === project.id ? { ...p, due_date: dueDate } : p)),
    flashId: () => project.id,
    onSuccess: (row) => settleProject(queryClient, project.id, row),
    onError: () => showToast(t('aito.dueDateFailed'), 'error'),
  });
}
