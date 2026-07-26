import { useTranslation } from 'react-i18next';
import { DeleteHoldButton } from './DeleteHoldButton';
import type { AitoProject } from '../../api/client';
import { formatElapsedTime, parseUTCDate } from '../../utils/date';

export interface CardViewProps {
  project: AitoProject;
  overlay?: boolean;
  onDelete?: () => void;
}

// Presentational card, shared by the in-column sortable wrapper and the
// DragOverlay clone (which must not carry sortable listeners/transform).
export function CardView({ project, overlay = false, onDelete }: CardViewProps) {
  const { t, i18n } = useTranslation();
  const created = parseUTCDate(project.created_at);
  const updated = parseUTCDate(project.updated_at);
  const elapsed = formatElapsedTime(project.created_at, t);
  const dateTitle = [
    created && t('aito.created', { date: created.toLocaleString(i18n.language) }),
    updated && t('aito.updated', { date: updated.toLocaleString(i18n.language) }),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div
      className={`group relative rounded-xl border bg-bambu-dark-secondary p-3 select-none ${
        overlay
          ? 'rotate-2 scale-[1.03] border-bambu-green/40 shadow-2xl cursor-grabbing'
          : 'border-bambu-dark-tertiary card-shadow cursor-grab active:cursor-grabbing transition-[border-color,box-shadow] duration-100 hover:border-bambu-green/40 hover:shadow-lg'
      }`}
    >
      <span className="text-xs text-bambu-gray tabular-nums">#{project.id}</span>
      {project.client_name && (
        <div className="mt-1">
          <p className="text-sm font-medium text-white truncate">{project.client_name}</p>
          {project.client_phone && (
            <a
              href={`tel:${project.client_phone}`}
              onPointerDown={(e) => e.stopPropagation()}
              className="text-xs text-bambu-gray hover:text-bambu-green"
            >
              {project.client_phone}
            </a>
          )}
        </div>
      )}
      <p className="mt-1 text-sm text-white whitespace-pre-wrap break-words line-clamp-5">{project.description}</p>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-bambu-gray" title={dateTitle}>
          {elapsed}
        </span>
        {onDelete && (
          <DeleteHoldButton onDelete={onDelete} label={t('aito.deleteTitle')} hint={t('aito.holdToDelete')} />
        )}
      </div>
    </div>
  );
}
