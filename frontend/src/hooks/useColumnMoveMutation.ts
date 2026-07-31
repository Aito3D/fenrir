import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useOptimisticBoardMutation } from './useOptimisticBoardMutation';
import { applyColumnMove } from '../utils/aitoOptimistic';
import { api, type AitoProject } from '../api/client';
import { useToast } from '../contexts/ToastContext';

/** The board's one manual transition: Finish <-> Done.
 *
 *  Every other column is derived by `aito_board_rules.evaluate` from the quote
 *  status and the task steps. These two are the sole pair the rules hand back
 *  to the user (`move_lock === null`), which is why this is the only hook that
 *  writes a column directly.
 *
 *  `position: 0` on purpose: the card lands at the TOP of its destination. In
 *  Done that is invisible — the grid sorts by `updated_at` — but on the way
 *  back it is the whole point, since the thing you just un-archived is the
 *  thing you want to see.
 *
 *  Caller gates on `project.move_lock === null` before rendering a button.
 *  That is the server's derived value, and it is also what keeps a declined
 *  quote out: the rules pin those to Done with `move_lock: 'declined'` and the
 *  move endpoint 409s the attempt. */
export function useColumnMoveMutation(project: AitoProject, column: 'done' | 'finish') {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  return useOptimisticBoardMutation<AitoProject, void>({
    mutationFn: () => api.moveAitoProject(project.id, { column, position: 0 }),
    transform: (previous) => applyColumnMove(previous, project.id, column),
    flashId: () => project.id,
    onSuccess: (row) => {
      // The server's own row over the prediction — it carries the recomputed
      // `move_lock` and the real `updated_at`, which is what the done grid
      // sorts on.
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        prev?.map((p) => (p.id === row.id ? row : p)) ?? prev,
      );
      queryClient.invalidateQueries({ queryKey: ['aito-events', project.id] });
    },
    onError: () => showToast(t('aito.moveFailed'), 'error'),
  });
}
