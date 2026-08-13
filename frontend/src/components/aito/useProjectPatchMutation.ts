import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, type AitoProject, type AitoProjectUpdate } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { latestProjectVersion, useOptimisticBoardMutation } from '../../hooks/useOptimisticBoardMutation';
import { showVersionConflictToast } from './versionConflictToast';

/** The freshest version THIS CLIENT has personally seen the server acknowledge
 *  for a project, keyed by project id, stored as the PAIR it came from —
 *  `{from: expectedVersionSent, to: responseVersion}` — rather than just the
 *  resulting version. Deliberately NOT the same thing as reading
 *  `['aito-projects']` (that's what `latestProjectVersion` does): that cache
 *  is also rewritten wholesale by a WS-triggered refetch the instant ANOTHER
 *  operator saves (`aito_changed` -> `boardSync.resyncIfIdle` ->
 *  `invalidateQueries(['aito-projects'])`), so reading it back as this
 *  client's own "last known good" version would silently adopt someone
 *  else's write as the new baseline — exactly the hole this map exists to
 *  close. Only this hook's own `mutationFn` — for the PATCH it itself just
 *  sent — writes to it. Module-level, not per-hook-instance, because
 *  `ProjectDetailPanel`'s two mutations (description, social) and
 *  `ShippingCard`'s third (shipping) all edit the same project and must agree
 *  on what "our own last save" saw.
 *
 *  T-047: an earlier revision raised a session's captured version to
 *  `Math.max(patch.expected_version, ownAckedVersion.get(project.id))`
 *  unconditionally. That is right for a same-client back-to-back save (see
 *  the `mutationFn` doc below) but wrong once ANOTHER client's write lands in
 *  between: if this client acks a newer version for an unrelated reason (its
 *  own save of a DIFFERENT field, opened AFTER a peer's write), the `Math.max`
 *  would still raise a stale editor's session capture up to that newer ack —
 *  even though the ack does not descend from the same base the stale editor
 *  was built on — and the stale save would sail straight past the version
 *  guard onto the server, silently overwriting the peer's write with no 409.
 *  Storing the `{from, to}` pair lets `mutationFn` check that the ack's
 *  starting point (`from`) is `<=` the session's own captured version before
 *  trusting its endpoint (`to`) at all — i.e. that the ack genuinely descends
 *  from the same base — which still covers the same-client burst the
 *  mechanism was built for (see AitoDetailPanelOptimistic.test.tsx's F2
 *  suite) while rejecting the cross-operator sequence (see its T-047 suite).
 *
 *  A second, narrower bug surfaced once that descent check existed: when it
 *  passes, the captured version must still only ever be RAISED, never
 *  lowered, to the ack's `to` — an early revision of this fix substituted
 *  `acked.to` outright, which regressed the ordinary case where a session
 *  opens FRESH, after a peer's write, at a version already newer than this
 *  client's last (unrelated) ack: e.g. this client's own save moved 3 -> 4,
 *  a peer then moved the server to 5, and a brand-new editor opened and
 *  captured 5 — `acked.from` (3) is `<=` 5 so the descent check passes, but
 *  substituting `acked.to` (4) would send a value OLDER than the session's
 *  own fresh capture, drawing a false 409 against a save that was never
 *  stale. `Math.max(patch.expected_version, acked.to)` is what actually
 *  belongs behind the descent check — see the `mutationFn` doc below and
 *  AitoDetailPanelOptimistic.test.tsx's S1 case in the T-047 suite. */
const ownAckedVersion = new Map<number, { from: number; to: number }>();

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
 *    already moved — is what the server should check against. It is raised —
 *    NEVER lowered — to the freshest `ownAckedVersion` entry's `to`, and only
 *    when that entry's own `from` (the expected_version IT was sent with) is
 *    `<=` this session's captured version — i.e. only when the ack genuinely
 *    descends from the same base this editor was opened against, and even
 *    then only if the ack is actually newer than what this session already
 *    captured. That still covers a same-client back-to-back save (blur the
 *    description, then Save the shipping card before the first PATCH
 *    resolves): both sessions captured the same pre-burst version, so the
 *    first save's ack (`from` == that same version) trivially qualifies, and
 *    the second session's `Math.max` picks up its `to` rather than
 *    re-fighting a conflict against itself — see
 *    AitoDetailPanelOptimistic.test.tsx's F2 suite, which pins this exact
 *    race. It stops covering — and correctly now 409s — a stale session left
 *    open across ANOTHER client's write, even when this client has since
 *    acked a newer version for an unrelated reason (F2's mirror image, the
 *    T-047 suite's cross-operator case). And the `Math.max` (rather than an
 *    outright substitution) keeps it from drawing a FALSE 409 against a
 *    freshly-opened session that already captured a version newer than this
 *    client's last unrelated ack — an own-save-then-peer-write-then-fresh-
 *    editor sequence, the mirror image of the cross-operator case, pinned by
 *    the T-047 suite's S1 case.
 *  - Anything else (retry-sync, the description regenerate action, removing a
 *    shipment) is a one-shot action with no editor session to have gone stale
 *    against, so it keeps reading `latestProjectVersion(queryClient, ...)` —
 *    unchanged from before.
 *
 *  The actual `expected_version` put on the wire is recorded as the ack's
 *  `from` the moment the request settles, inside `mutationFn`'s own promise
 *  chain (not in `onSuccess`, which runs off `useMutation`'s original
 *  `vars` — the pre-resolution `patch` — and would have no way to know
 *  whether this particular call raised the session capture). `onSuccess`
 *  itself only writes the PATCH response into the `['aito-projects']` cache
 *  and invalidates `['aito-events', project.id]` — every board write records
 *  a `project.updated` event server-side, and `RecordCard`/`ActivityRail`
 *  need that invalidation to pick it up. `onError` shows the shared
 *  version-conflict toast. */
export function useProjectPatchMutation(
  project: AitoProject,
  transform: (previous: AitoProject[] | undefined, patch: AitoProjectUpdate) => AitoProject[] | undefined,
) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { showToast } = useToast();

  return useOptimisticBoardMutation<AitoProject, AitoProjectUpdate>({
    mutationFn: (patch) => {
      let expectedVersion: number;
      if (patch.expected_version !== undefined) {
        const acked = ownAckedVersion.get(project.id);
        expectedVersion =
          acked && acked.from <= patch.expected_version
            ? Math.max(patch.expected_version, acked.to)
            : patch.expected_version;
      } else {
        expectedVersion = latestProjectVersion(queryClient, project.id, project.version);
      }
      return api
        .updateAitoProject(project.id, { ...patch, expected_version: expectedVersion })
        .then((updatedProject) => {
          ownAckedVersion.set(updatedProject.id, { from: expectedVersion, to: updatedProject.version });
          return updatedProject;
        });
    },
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
