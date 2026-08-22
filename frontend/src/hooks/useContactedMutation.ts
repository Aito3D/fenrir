import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useOptimisticBoardMutation } from './useOptimisticBoardMutation';
import { api, type AitoProject } from '../api/client';
import { useToast } from '../contexts/ToastContext';

/** Record — or take back — the fact that the client has been told their job is
 *  ready to collect.
 *
 *  Sibling of `useFlagMutation` in every respect that matters: one field, an
 *  optimistic write, the server's row over the prediction on success. The
 *  difference is what the field DOES — this one opens the Finish -> Done gate,
 *  so the optimistic write is what makes the card's footer button change from
 *  the contact button into Done without waiting for a round trip.
 *
 *  The predicted timestamp is deliberately a placeholder the server then
 *  overwrites: nothing reads its VALUE during the flight (the card only asks
 *  whether it is null), and inventing a plausible one from a browser clock
 *  that may be wrong is how the card ends up claiming the client was rung
 *  tomorrow. */
export function useContactedMutation(project: AitoProject) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  return useOptimisticBoardMutation<AitoProject, boolean>({
    mutationFn: (contacted) => api.setAitoProjectContacted(project.id, contacted),
    transform: (previous, contacted) =>
      previous?.map((p) =>
        p.id === project.id
          ? { ...p, client_contacted_at: contacted ? (p.client_contacted_at ?? new Date().toISOString()) : null }
          : p,
      ),
    flashId: () => project.id,
    onSuccess: (row) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        prev?.map((p) => (p.id === row.id ? row : p)) ?? prev,
      );
      queryClient.invalidateQueries({ queryKey: ['aito-events', project.id] });
    },
    onError: () => showToast(t('aito.contactedFailed'), 'error'),
  });
}
