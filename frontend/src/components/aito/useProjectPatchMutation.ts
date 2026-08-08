import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, type AitoProject, type AitoProjectUpdate } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { latestProjectVersion, useOptimisticBoardMutation } from '../../hooks/useOptimisticBoardMutation';
import { showVersionConflictToast } from './versionConflictToast';

/** The `useOptimisticBoardMutation` wiring every project-PATCH mutation on
 *  the board shares — `ProjectDetailPanel`'s description save, its social
 *  save, and `ShippingCard`'s shipping save were three copies of this exact
 *  config, differing only in `transform`. One place to keep the other five
 *  fields (`mutationFn`, `flashId`, `onSuccess`, `onError`) from drifting.
 *
 *  `mutationFn` reads `latestProjectVersion(queryClient, ...)` rather than
 *  closing over `project.version` — see that function's own doc — so a
 *  same-client back-to-back save (e.g. blur the description, then Save the
 *  shipping card before the first PATCH resolves) always carries the freshest
 *  ACKED version, not a render-stale one. `onSuccess` writes the PATCH
 *  response straight into the `['aito-projects']` cache and invalidates
 *  `['aito-events', project.id]` — every board write records a
 *  `project.updated` event server-side, and `RecordCard`/`ActivityRail` need
 *  that invalidation to pick it up. `onError` shows the shared version-conflict
 *  toast. */
export function useProjectPatchMutation(
  project: AitoProject,
  transform: (previous: AitoProject[] | undefined, patch: AitoProjectUpdate) => AitoProject[] | undefined,
) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { showToast } = useToast();

  return useOptimisticBoardMutation<AitoProject, AitoProjectUpdate>({
    mutationFn: (patch) =>
      api.updateAitoProject(project.id, { ...patch, expected_version: latestProjectVersion(queryClient, project.id, project.version) }),
    transform,
    flashId: () => project.id,
    onSuccess: (updatedProject) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        prev?.map((p) => (p.id === updatedProject.id ? updatedProject : p)) ?? prev,
      );
      queryClient.invalidateQueries({ queryKey: ['aito-events', project.id] });
    },
    onError: (error) => showVersionConflictToast(error, t, showToast),
  });
}
