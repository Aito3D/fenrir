import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type AitoProject } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { useOptimisticBoardMutation } from '../../hooks/useOptimisticBoardMutation';
import { applyRestore, replaceProject } from '../../utils/aitoOptimistic';

/** Restore a trashed project: shared by the trash card and the open panel's footer. */
export function useRestoreProject() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const restore = useOptimisticBoardMutation<AitoProject, AitoProject>({
    mutationFn: (target) => api.restoreAitoProject(target.id),
    // The restored card lands on the board immediately. Its column comes from
    // the server on success — the trash row's stored column can be stale, and
    // the rules may relocate it — so this is the one transform that predicts a
    // column it does not compute.
    // applyRestore, not applyCreate: restore_project APPENDS to the end of
    // the card's own column, where create_project prepends to Devis.
    transform: (previous, target) => applyRestore(previous, { ...target, status: 'active' }),
    flashId: (target) => target.id,
    onSuccess: (restored) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) => replaceProject(prev, restored));
      queryClient.invalidateQueries({ queryKey: ['aito-trash'] });
      showToast(t('aito.restored'));
    },
    onError: (error) => {
      const conflict = error instanceof ApiError && error.status === 409;
      showToast(t(conflict ? 'aito.restoreBlockedByQuote' : 'aito.restoreFailed'), 'error');
      queryClient.invalidateQueries({ queryKey: ['aito-trash'] });
    },
  });
  return {
    isPending: restore.isPending,
    run: (project: AitoProject) => {
      // Drop it from the trash list too — the mutation wrapper's transform only owns the board query.
      queryClient.setQueryData<AitoProject[]>(['aito-trash'], (prev) => prev?.filter((p) => p.id !== project.id) ?? prev);
      restore.mutate(project);
    },
  };
}
