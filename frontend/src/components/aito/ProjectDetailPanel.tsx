import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, X } from 'lucide-react';
import { COLUMNS } from './columns';
import { AITO_CARD_VT_NAME } from '../../hooks/useCardMorph';
import { api, type AitoProject, type AitoProjectUpdate } from '../../api/client';
import { parseUTCDate } from '../../utils/date';
import { inputCls } from '../formStyles';
import { useToast } from '../../contexts/ToastContext';

interface ProjectDetailPanelProps {
  project: AitoProject;
  onClose: () => void;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

function SaveIndicator({ state }: { state: SaveState }) {
  const { t } = useTranslation();
  if (state === 'saving') return <Loader2 className="w-3.5 h-3.5 text-bambu-gray animate-spin" />;
  if (state === 'saved') {
    return (
      <span className="flex items-center gap-1 text-xs text-bambu-green animate-fade-in">
        <Check className="w-3.5 h-3.5" />
        {t('aito.saved')}
      </span>
    );
  }
  return null;
}

/** Everything a card cannot fit: the untruncated description, the timestamps
 *  and the stage. Shares AITO_CARD_VT_NAME with the card it grew out of, so the
 *  browser morphs one into the other (see useCardMorph). */
export function ProjectDetailPanel({ project, onClose }: ProjectDetailPanelProps) {
  const { t, i18n } = useTranslation();
  const closeRef = useRef<HTMLButtonElement>(null);
  const column = COLUMNS.find((c) => c.id === project.column);
  const created = parseUTCDate(project.created_at);
  const updated = parseUTCDate(project.updated_at);

  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const updateMutation = useMutation({
    mutationFn: (patch: AitoProjectUpdate) => api.updateAitoProject(project.id, patch),
    onSuccess: (updatedProject) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        prev?.map((p) => (p.id === updatedProject.id ? updatedProject : p)) ?? prev,
      );
    },
    onError: () => showToast(t('aito.saveFailed'), 'error'),
  });

  const [editingDesc, setEditingDesc] = useState(false);
  const [draft, setDraft] = useState(project.description);
  const [descState, setDescState] = useState<SaveState>('idle');

  // Follow the server value while idle; never clobber text being typed.
  useEffect(() => {
    if (!editingDesc) setDraft(project.description);
  }, [project.description, editingDesc]);

  // 'saved' is a transient acknowledgement, not a state to sit in.
  useEffect(() => {
    if (descState !== 'saved') return;
    const id = setTimeout(() => setDescState('idle'), 1500);
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
    updateMutation.mutate(
      { description: next },
      {
        onSuccess: () => setDescState('saved'),
        onError: () => {
          setDescState('error');
          setDraft(project.description);
        },
      },
    );
  };

  const editingRef = useRef(false);
  editingRef.current = editingDesc;

  // onClose is a fresh inline closure on every AitoPage render, so it cannot be
  // an effect dependency: the effect would re-run on every re-render and steal
  // focus back from whatever the user is editing.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editingRef.current) onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 [view-transition-name:aito-backdrop]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={project.client_name ?? t('aito.noClient')}
        style={{ viewTransitionName: AITO_CARD_VT_NAME }}
        className="bg-bambu-dark-secondary rounded-xl w-full max-w-md border border-bambu-dark-tertiary flex flex-col max-h-[calc(100vh-2rem)]"
      >
        <div className="p-4 border-b border-bambu-dark-tertiary flex items-start justify-between gap-3 flex-shrink-0">
          <div className="min-w-0">
            <h2 className={`text-lg font-semibold truncate ${project.client_name ? 'text-white' : 'text-bambu-gray'}`}>
              {project.client_name ?? t('aito.noClient')}
            </h2>
            {project.client_phone && (
              <a href={`tel:${project.client_phone}`} className="text-sm text-bambu-gray hover:text-bambu-green">
                {project.client_phone}
              </a>
            )}
            {project.client_email && (
              <a
                href={`mailto:${project.client_email}`}
                className="block text-sm text-bambu-gray hover:text-bambu-green"
              >
                {project.client_email}
              </a>
            )}
          </div>
          <button
            type="button"
            ref={closeRef}
            aria-label={t('common.close')}
            onClick={onClose}
            className="p-1 -m-1 rounded-md text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 overflow-y-auto flex-1 space-y-4">
          <div className="flex items-start justify-between gap-2">
            {editingDesc ? (
              <textarea
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={saveDescription}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    // Stop the panel's window-level Escape handler: the first
                    // Escape abandons the edit, it does not close the panel.
                    e.stopPropagation();
                    setDraft(project.description);
                    setEditingDesc(false);
                  }
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') saveDescription();
                }}
                rows={5}
                className={`${inputCls} resize-none flex-1`}
              />
            ) : (
              <p
                role="button"
                tabIndex={0}
                aria-label={t('aito.editDescription')}
                onClick={() => setEditingDesc(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setEditingDesc(true);
                  }
                }}
                className="flex-1 text-sm text-white whitespace-pre-wrap break-words cursor-text rounded-md -m-1 p-1 hover:bg-bambu-dark-tertiary/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"
              >
                {project.description}
              </p>
            )}
            <SaveIndicator state={descState} />
          </div>

          <dl className="border-t border-bambu-dark-tertiary pt-4 space-y-2 text-sm">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-bambu-gray">{t('aito.createdLabel')}</dt>
              <dd className="text-white text-right">{created ? created.toLocaleString(i18n.language) : '—'}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-bambu-gray">{t('aito.lastActivity')}</dt>
              <dd className="text-white text-right">{updated ? updated.toLocaleString(i18n.language) : '—'}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-bambu-gray">{t('aito.stage')}</dt>
              <dd className="text-white flex items-center gap-2">
                {column && <span className={`w-2 h-2 rounded-full ${column.dot}`} />}
                {column ? t(column.labelKey) : project.column}
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}
