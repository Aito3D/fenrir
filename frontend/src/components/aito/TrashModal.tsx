import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, X } from 'lucide-react';
import { api } from '../../api/client';
import { Button } from '../Button';
import { useToast } from '../../contexts/ToastContext';
import { formatElapsedTime } from '../../utils/date';

export function TrashModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const trashQuery = useQuery({ queryKey: ['aito-trash'], queryFn: api.getAitoTrash });

  const restoreMutation = useMutation({
    mutationFn: (id: number) => api.restoreAitoProject(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
      queryClient.invalidateQueries({ queryKey: ['aito-trash'] });
      showToast(t('aito.restored'));
    },
    onError: () => {
      showToast(t('aito.restoreFailed'), 'error');
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
                    onClick={() => restoreMutation.mutate(project.id)}
                    disabled={restoreMutation.isPending && restoreMutation.variables === project.id}
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
