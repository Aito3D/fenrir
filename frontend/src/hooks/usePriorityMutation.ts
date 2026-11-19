import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useOptimisticBoardMutation } from './useOptimisticBoardMutation';
import { settleProject } from '../components/aito/settleProject';
import { api, ApiError, type AitoPriority, type AitoProject } from '../api/client';
import { useToast } from '../contexts/ToastContext';

/** Set a project's priority level. Mirrors useDueDateMutation; the server
 *  answers 409 on an invoiced quote, and the optimistic write reverts. */
export function usePriorityMutation(project: AitoProject) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  return useOptimisticBoardMutation<AitoProject, AitoPriority>({
    mutationFn: (priority) => api.setAitoPriority(project.id, priority),
    transform: (previous, priority) => previous?.map((p) => (p.id === project.id ? { ...p, priority } : p)),
    flashId: () => project.id,
    onSuccess: (row) => settleProject(queryClient, project.id, row),
    onError: (error) =>
      showToast(
        `${t('aito.saveFailed')}${error instanceof ApiError && error.status === 409 ? ` ${error.message}` : ''}`,
        'error',
      ),
  });
}
