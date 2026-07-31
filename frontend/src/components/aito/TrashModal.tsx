import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, X } from 'lucide-react';
import { api, ApiError, type AitoProject } from '../../api/client';
import { Button } from '../Button';
import { useToast } from '../../contexts/ToastContext';
import { formatElapsedTime } from '../../utils/date';
import { useOptimisticBoardMutation } from '../../hooks/useOptimisticBoardMutation';
import { applyRestore } from '../../utils/aitoOptimistic';

export function TrashModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const trashQuery = useQuery({ queryKey: ['aito-trash'], queryFn: api.getAitoTrash });

  const restoreMutation = useOptimisticBoardMutation<AitoProject, AitoProject>({
    mutationFn: (project) => api.restoreAitoProject(project.id),
    // The restored card lands on the board immediately. Its column comes from
    // the server on success — the trash row's stored column can be stale, and
    // the rules may relocate it — so this is the one transform that predicts a
    // column it does not compute.
    // applyRestore, not applyCreate: restore_project APPENDS to the end of
    // the card's own column, where create_project prepends to Devis.
    transform: (previous, project) => applyRestore(previous, { ...project, status: 'active' }),
    flashId: (project) => project.id,
    onSuccess: (restored) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        prev?.map((p) => (p.id === restored.id ? restored : p)) ?? prev,
      );
      queryClient.invalidateQueries({ queryKey: ['aito-trash'] });
      showToast(t('aito.restored'));
    },
    onError: (error) => {
      const conflict = error instanceof ApiError && error.status === 409;
      showToast(t(conflict ? 'aito.restoreBlockedByQuote' : 'aito.restoreFailed'), 'error');
      queryClient.invalidateQueries({ queryKey: ['aito-trash'] });
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const projects = trashQuery.data ?? [];

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 animate-overlay-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-bambu-dark-secondary rounded-xl w-full max-w-lg border border-bambu-dark-tertiary flex flex-col max-h-[calc(100vh-2rem)] animate-modal-in">
        <div className="p-4 border-b border-bambu-dark-tertiary flex items-center justify-between flex-shrink-0">
          <h2 className="text-lg font-semibold text-white">{t('aito.trashTitle')}</h2>
          <button
            type="button"
            aria-label={t('common.close')}
            onClick={onClose}
            className="p-1 -m-1 rounded-md text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 overflow-y-auto flex-1">
          {projects.length === 0 ? (
            <div className="text-center py-8">
              <Trash2 className="w-8 h-8 text-bambu-gray mx-auto mb-2 opacity-40" />
              <p className="text-sm text-bambu-gray">{t('aito.trashEmpty')}</p>
            </div>
          ) : (
            <div className="space-y-2 stagger-children">
              {projects.map((project) => (
                <div
                  key={project.id}
                  className="animate-rise flex items-center gap-3 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary/60 p-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-bambu-gray tabular-nums">#{project.id}</span>
                      {project.client_name && (
                        <span className="text-sm font-medium text-white truncate">{project.client_name}</span>
                      )}
                    </div>
                    <p className="mt-0.5 text-sm text-bambu-gray whitespace-pre-wrap break-words line-clamp-2">
                      {project.description}
                    </p>
                    <p className="mt-1 text-xs text-bambu-gray">
                      {t('aito.deletedOn', { date: formatElapsedTime(project.updated_at, t) })}
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      // Drop it from the trash list too — the wrapper's
                      // transform only owns the board query.
                      queryClient.setQueryData<AitoProject[]>(['aito-trash'], (prev) =>
                        prev?.filter((p) => p.id !== project.id) ?? prev,
                      );
                      restoreMutation.mutate(project);
                    }}
                    disabled={restoreMutation.isPending && restoreMutation.variables?.id === project.id}
                  >
                    {t('aito.restore')}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
