import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Merge } from 'lucide-react';
import { Button } from '../Button';
import { api, ApiError, type AitoProject } from '../../api/client';
import { useDismissableDialog } from '../../hooks/useDismissableDialog';
import { useToast } from '../../contexts/ToastContext';
import { AitoDialogShell } from './AitoDialogShell';
import { CandidatePicker } from './CandidatePicker';
import { mergeCandidates } from './mergeCandidates';

/** A beat past .animate-modal-out's 150ms — the margin ClientHistoryModal gives. */
const MODAL_OUT_MS = 170;

/** Pick another card; its tasks and steps are copied onto this one and it
 *  goes to the trash — one request (POST /{id}/merge), one timeline story.
 *
 *  Rendered by the panel, so it stacks above it (z-[110] against the panel's
 *  z-50 backdrop). The panel stays open underneath: on success the task
 *  list and board are invalidated, and `useProjectTasks`' own resync adopts
 *  the copies the moment they land, so the operator is still on the card,
 *  now with everything in one place. */
export function MergeProjectModal({ project, onClose }: { project: AitoProject; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { closing, requestClose, dialogRef } = useDismissableDialog(onClose, { animationMs: MODAL_OUT_MS });
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Same key (and cache entry) as CandidateList's: read here only for the
  // toast's task count and the dialog's busy flag.
  const board = useQuery({ queryKey: ['aito-projects'], queryFn: api.getAitoProjects });
  const candidates = useMemo(() => mergeCandidates(board.data ?? [], project), [board.data, project]);
  const selected = candidates.find((p) => p.id === selectedId) ?? null;

  const merge = useMutation({
    mutationFn: (sourceId: number) => api.mergeAitoProject(project.id, sourceId),
    onSuccess: (_, sourceId) => {
      const source = candidates.find((p) => p.id === sourceId);
      queryClient.invalidateQueries({ queryKey: ['aito-tasks', project.id] });
      queryClient.invalidateQueries({ queryKey: ['aito-events', project.id] });
      queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
      queryClient.invalidateQueries({ queryKey: ['aito-trash'] });
      showToast(t('aito.mergeDone', { count: source?.task_count ?? 0, id: sourceId }), 'success');
      onClose();
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : t('aito.mergeError'));
    },
  });

  return (
    <AitoDialogShell
      label={t('aito.mergeTitle')}
      testId="merge-project-modal"
      icon={Merge}
      subtitle={t('aito.mergeBody')}
      closing={closing}
      requestClose={requestClose}
      dialogRef={dialogRef}
      busy={merge.isPending}
      ariaBusy={board.isPending}
      maxWidthCls="max-w-[560px]"
      capHeight
    >

      <CandidatePicker
        project={project}
        selectedId={selectedId}
        query={query}
        onQueryChange={setQuery}
        ariaLabel={t('aito.mergeTitle')}
        onSelect={(id) => {
          setSelectedId(id);
          setError(null);
        }}
      />

      <footer className="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3">
        <p role="alert" className="min-w-0 truncate text-xs text-red-400">
          {error}
        </p>
        <div className="flex flex-none items-center gap-2">
          <Button variant="secondary" size="sm" onClick={requestClose} disabled={merge.isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={selected === null || merge.isPending}
            onClick={() => selected && merge.mutate(selected.id)}
          >
            {merge.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {t('aito.mergeConfirm')}
          </Button>
        </div>
      </footer>
    </AitoDialogShell>
  );
}
