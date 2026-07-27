import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { COLUMNS } from './columns';
import { AITO_CARD_VT_NAME } from '../../hooks/useCardMorph';
import type { AitoProject } from '../../api/client';
import { parseUTCDate } from '../../utils/date';

interface ProjectDetailPanelProps {
  project: AitoProject;
  onClose: () => void;
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

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
          <p className="text-sm text-white whitespace-pre-wrap break-words">{project.description}</p>

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
