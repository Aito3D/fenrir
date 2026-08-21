import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useOptimisticBoardMutation } from './useOptimisticBoardMutation';
import { applyColumnMove } from '../utils/aitoOptimistic';
import { api, type AitoProject } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { useCelebration } from '../components/aito/celebration/context';

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
 *  move endpoint 409s the attempt.
 *
 *  It is also where the board celebrates. Finishing a project is the one thing
 *  this board is for, and this hook is the only way a card reaches Done from
 *  either surface — so the rule lives here rather than being spelled out (and
 *  eventually disagreed about) at each button. */
export function useColumnMoveMutation(
  project: AitoProject,
  column: 'done' | 'finish',
  /** Where the celebration should come from — read at click time, while the
   *  card is still where the user left it. Optional: a caller with nothing to
   *  measure (the done grid's restore) still archives, it just does not throw
   *  confetti from nowhere. */
  origin?: () => DOMRect | null,
) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const celebrate = useCelebration();

  return useOptimisticBoardMutation<AitoProject, void>({
    mutationFn: () => api.moveAitoProject(project.id, { column, position: 0 }),
    transform: (previous) => applyColumnMove(previous, project.id, column),
    flashId: () => project.id,
    onMutate: () => {
      // Done only. The same hook runs the move back OUT of Done, and
      // celebrating an un-archive would reward undoing the work.
      //
      // Fired here rather than in `onSuccess`: the card leaves the board on
      // this line's next neighbour, and a burst that waits for the round trip
      // arrives after the thing it is celebrating has already gone. A move
      // that then fails rolls back with the revert flash, which is the
      // board's existing answer for every optimistic write.
      if (column !== 'done') return;
      const rect = origin?.();
      if (rect) celebrate(rect);
    },
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
