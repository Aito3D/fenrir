import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, type AitoProject, type AitoProjectUpdate } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { latestProjectVersion, useOptimisticBoardMutation } from '../../hooks/useOptimisticBoardMutation';
import { showVersionConflictToast } from './versionConflictToast';

/** The freshest version THIS CLIENT has personally seen the server acknowledge
 *  for a project, keyed by project id. Deliberately NOT the same thing as
 *  reading `['aito-projects']` (that's what `latestProjectVersion` does): that
 *  cache is also rewritten wholesale by a WS-triggered refetch the instant
 *  ANOTHER operator saves (`aito_changed` -> `boardSync.resyncIfIdle` ->
 *  `invalidateQueries(['aito-projects'])`), so reading it back as this
 *  client's own "last known good" version would silently adopt someone
 *  else's write as the new baseline — exactly the hole this map exists to
 *  close. Only this hook's own `onSuccess` — which only ever fires for a PATCH
 *  THIS client sent — writes to it. Module-level, not per-hook-instance,
 *  because `ProjectDetailPanel`'s two mutations (description, social) and
 *  `ShippingCard`'s third (shipping) all edit the same project and must agree
 *  on what "our own last save" saw. */
const ownAckedVersion = new Map<number, number>();

/** Test-only: module state survives between tests in one file (same pattern
 *  as `__resetBoardSync` in `useBoardSync.ts`). Without this, a test that
 *  reuses a project id another test in the same file already patched would
 *  inherit that earlier test's acked version and could pass or fail
 *  depending on execution order. */
export function __resetOwnAckedVersion() {
  ownAckedVersion.clear();
}

/** The `useOptimisticBoardMutation` wiring every project-PATCH mutation on
 *  the board shares — `ProjectDetailPanel`'s description save, its social
 *  save, and `ShippingCard`'s shipping save were three copies of this exact
 *  config, differing only in `transform`. One place to keep the other five
 *  fields (`mutationFn`, `flashId`, `onSuccess`, `onError`) from drifting.
 *
 *  `mutationFn` picks `expected_version` from one of two sources depending on
 *  whether the caller passed one in `patch`:
 *
 *  - A typed edit session (`ProjectDetailPanel`'s description/social save,
 *    `ShippingCard`'s save) captures `project.version` the moment the editor
 *    opens and hands it back in `patch.expected_version` — see each call
 *    site's own comment. That captured value is the version the operator's
 *    edit is actually BASED ON, so it — not whatever the shared board cache
 *    happens to hold at save time, which a peer's concurrent write may have
 *    already moved — is what the server should check against. It is raised to
 *    `ownAckedVersion` (never lowered) so a same-client back-to-back save
 *    (blur the description, then Save the shipping card before the first
 *    PATCH resolves) still carries the freshest version THIS client's own
 *    prior write in the same burst just acked, rather than re-fighting a
 *    conflict against itself — see AitoDetailPanelOptimistic.test.tsx's F2
 *    suite, which pins this exact race.
 *  - Anything else (retry-sync, the description regenerate action, removing a
 *    shipment) is a one-shot action with no editor session to have gone stale
 *    against, so it keeps reading `latestProjectVersion(queryClient, ...)` —
 *    unchanged from before.
 *
 *  `onSuccess` records the acked version, writes the PATCH response straight
 *  into the `['aito-projects']` cache, and invalidates `['aito-events',
 *  project.id]` — every board write records a `project.updated` event
 *  server-side, and `RecordCard`/`ActivityRail` need that invalidation to pick
 *  it up. `onError` shows the shared version-conflict toast. */
export function useProjectPatchMutation(
  project: AitoProject,
  transform: (previous: AitoProject[] | undefined, patch: AitoProjectUpdate) => AitoProject[] | undefined,
) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { showToast } = useToast();

  return useOptimisticBoardMutation<AitoProject, AitoProjectUpdate>({
    mutationFn: (patch) => {
      const expectedVersion =
        patch.expected_version !== undefined
          ? Math.max(patch.expected_version, ownAckedVersion.get(project.id) ?? patch.expected_version)
          : latestProjectVersion(queryClient, project.id, project.version);
      return api.updateAitoProject(project.id, { ...patch, expected_version: expectedVersion });
    },
    transform,
    flashId: () => project.id,
    onSuccess: (updatedProject) => {
      ownAckedVersion.set(updatedProject.id, updatedProject.version);
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        prev?.map((p) => (p.id === updatedProject.id ? updatedProject : p)) ?? prev,
      );
      queryClient.invalidateQueries({ queryKey: ['aito-events', project.id] });
    },
    onError: (error) => showVersionConflictToast(error, t, showToast),
  });
}
