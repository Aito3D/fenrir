import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError, type AitoProject } from '../../api/client';
import { taskDraftToTaskCreate, type TaskDraft } from '../../utils/taskDraft';
import type { useProjectPatchMutation } from './useProjectPatchMutation';

// 'leaving' is the last 150ms of 'saved': the acknowledgement faded in, so
// it fades out on the same beat (.animate-fade-out-sm) rather than vanishing
// between two frames when its timer fires.
type SaveState = 'idle' | 'saving' | 'saved' | 'leaving';

interface DescriptionEditorOptions {
  project: AitoProject;
  /** The live task list the regenerate action summarises. */
  tasks: TaskDraft[];
  /** The panel's description PATCH (see its transform in ProjectDetailPanel). */
  updateMutation: ReturnType<typeof useProjectPatchMutation>;
  /** Flags the write for the panel's close-sync arbitration. */
  markExternalWrite: () => void;
  /** A failed regeneration only toasts. */
  onRegenerateError: () => void;
}

/** The Product description card's editor: the draft, the edit session and its
 *  captured version, the clamp/expand measurement, the save indicator, and
 *  the AI regenerate action. Called by ProjectDetailPanel at the exact point
 *  its body used to declare all of this, so hook order and effect order are
 *  unchanged and every piece of state lives as long as the panel does. */
export function useDescriptionEditor({
  project,
  tasks,
  updateMutation,
  markExternalWrite,
  onRegenerateError,
}: DescriptionEditorOptions) {
  const [editingDesc, setEditingDesc] = useState(false);
  const [draft, setDraft] = useState(project.description);
  // Six lines at rest, the whole text on request. The left column is the
  // panel's shortest now that the reference cards sit behind a tab, and a
  // long description is the one thing that can still make it outgrow the
  // task list. Overflow is measured, not guessed from a character count:
  // the clamp is CSS, so only the element knows whether it clipped anything.
  const [descExpanded, setDescExpanded] = useState(false);
  const [descOverflows, setDescOverflows] = useState(false);
  const descRef = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    // Measured while clamped only: once expanded there is nothing to clip,
    // and the "Show less" affordance keeps the answer from the last clamp.
    if (editingDesc || descExpanded) return;
    const el = descRef.current;
    if (el) setDescOverflows(el.scrollHeight > el.clientHeight);
  }, [project.description, editingDesc, descExpanded]);
  const [descState, setDescState] = useState<SaveState>('idle');

  // The version this edit session is BASED ON, captured once when the
  // textarea opens (see the two `setEditingDesc(true)` call sites below) —
  // see useProjectPatchMutation's doc for why this beats re-reading
  // `project.version` at save time. `undefined` means "no session-captured
  // version" and falls back to the pre-existing latestProjectVersion
  // behaviour — used for the regenerate action below (never opens the
  // textarea) and for a retry after THIS session's own save already failed
  // once (cleared in `saveDescription`'s `onError`, so a second attempt does
  // not keep re-fighting the same now-stale capture forever).
  const descEditVersionRef = useRef<number | undefined>(undefined);

  // Shared by the paragraph's click and keyboard (Enter/Space) activation
  // below — one place that captures the session's version, not two copies
  // that could drift.
  const beginEditDescription = () => {
    descEditVersionRef.current = project.version;
    setEditingDesc(true);
  };

  // Follow the server value while idle; never clobber text being typed.
  useEffect(() => {
    if (!editingDesc) setDraft(project.description);
  }, [project.description, editingDesc]);

  // 'saved' is a transient acknowledgement, not a state to sit in: 1500ms,
  // then the 150ms exit fade ('leaving', matching .animate-fade-out-sm), then
  // gone.
  useEffect(() => {
    if (descState !== 'saved' && descState !== 'leaving') return;
    const id = setTimeout(
      () => setDescState(descState === 'saved' ? 'leaving' : 'idle'),
      descState === 'saved' ? 1500 : 150,
    );
    return () => clearTimeout(id);
  }, [descState]);

  const saveDescription = () => {
    setEditingDesc(false);
    const next = draft.trim();
    // Blank is rejected by the backend (min_length=1) and is almost always an
    // accidental select-all-delete, so revert rather than round-trip an error.
    if (!next || next === project.description) {
      setDraft(project.description);
      return;
    }
    setDescState('saving');
    markExternalWrite();
    updateMutation.mutate(
      { description: next, expected_version: descEditVersionRef.current },
      {
        onSuccess: () => setDescState('saved'),
        onError: (error) => {
          setDescState('idle');
          // A retry (of any failure, not just a conflict) should not keep
          // resending this session's now-stale capture — see the ref's own
          // doc.
          descEditVersionRef.current = undefined;
          // The spec's error-handling table promises the operator's typed
          // text survives a version conflict (someone else saved first):
          // reopen the editor with exactly what they typed rather than the
          // revert-to-server behaviour every other failure gets, so a retry
          // after the board refresh doesn't cost them the edit. `next`, not
          // `draft` — `draft` may already have been reset to the (now
          // stale) `project.description` by the effect above, which fires
          // the instant `setEditingDesc(false)` above lands.
          if (error instanceof ApiError && error.code === 'version_conflict') {
            setDraft(next);
            setEditingDesc(true);
            return;
          }
          setDraft(project.description);
        },
      },
    );
  };

  // Regenerates the description from the live tasks through the same
  // stateless /aito/summarize endpoint the creation drawer uses, then saves
  // immediately through the manual-edit path so the descState indicator and
  // the optimistic board update behave identically. A failed generation only
  // toasts — unlike the drawer, this panel always has a real description, and
  // buildFallbackSummary would replace it with a worse one.
  const regenerateMutation = useMutation({
    mutationFn: () => api.summarizeAitoProject(tasks.map(taskDraftToTaskCreate)),
    onSuccess: ({ summary }) => {
      const next = summary.trim();
      if (!next || next === project.description) {
        setDescState('saved');
        return;
      }
      setDescState('saving');
      markExternalWrite();
      updateMutation.mutate(
        { description: next },
        {
          onSuccess: () => setDescState('saved'),
          onError: () => {
            setDescState('idle');
            setDraft(project.description);
          },
        },
      );
    },
    onError: onRegenerateError,
  });

  return {
    editingDesc,
    setEditingDesc,
    draft,
    setDraft,
    descExpanded,
    setDescExpanded,
    descOverflows,
    descRef,
    descState,
    beginEditDescription,
    saveDescription,
    regenerateMutation,
  };
}
