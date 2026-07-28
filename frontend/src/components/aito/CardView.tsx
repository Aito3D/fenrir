import { useTranslation } from 'react-i18next';
import { GripVertical } from 'lucide-react';
import { DeleteHoldButton } from './DeleteHoldButton';
import type { AitoProject } from '../../api/client';
import { formatElapsedTime, parseUTCDate } from '../../utils/date';

export interface CardViewProps {
  project: AitoProject;
  overlay?: boolean;
  onDelete?: () => void;
  onExpand?: () => void;
  /** dnd-kit's setActivatorNodeRef — omitted by the DragOverlay clone. */
  dragHandleRef?: (element: HTMLElement | null) => void;
  /** dnd-kit's attributes + listeners, spread onto the grip. */
  dragHandleProps?: Record<string, unknown>;
}

/** Presentational card, shared by the in-column sortable wrapper and the
 *  DragOverlay clone.
 *
 *  Three zones with distinct jobs: the header carries the client name and is
 *  the ONLY drag source (via the grip); the body is the only thing that opens
 *  the detail panel; the footer holds the timestamp and delete. Phone and email
 *  live in the detail panel, not here.
 *
 *  The footer sits outside the body button because a <button> may not contain
 *  another button — the delete control could not otherwise exist. */
export function CardView({
  project,
  overlay = false,
  onDelete,
  onExpand,
  dragHandleRef,
  dragHandleProps,
}: CardViewProps) {
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
      data-aito-card
      data-aito-card-id={project.id}
      className={`group relative rounded-xl border bg-bambu-dark-secondary select-none ${
        overlay
          ? 'rotate-1 scale-[1.02] border-bambu-green/40 shadow-2xl cursor-grabbing'
          : 'border-bambu-dark-tertiary card-shadow transition-[border-color,box-shadow] duration-100 hover:border-bambu-green/40 hover:shadow-lg'
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-2 bg-bambu-dark-tertiary rounded-t-xl border-b border-bambu-dark-tertiary">
        <p
          className={`flex-1 text-sm font-medium truncate ${
            project.client_name ? 'text-white' : 'text-bambu-gray'
          }`}
        >
          {project.client_name ?? t('aito.noClient')}
        </p>
        {dragHandleProps ? (
          <button
            type="button"
            ref={dragHandleRef}
            aria-label={t('aito.dragHandle')}
            {...dragHandleProps}
            // touch-none belongs on the grip, not the card: on the card it
            // would block touch-scrolling the column from anywhere on a card.
            className="touch-none flex-shrink-0 p-1 -m-1 rounded-md text-bambu-gray cursor-grab active:cursor-grabbing hover:text-white hover:bg-bambu-dark-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"
          >
            <GripVertical className="w-4 h-4" />
          </button>
        ) : (
          <GripVertical className="w-4 h-4 flex-shrink-0 text-bambu-gray" aria-hidden="true" />
        )}
      </div>

      {onExpand ? (
        <button
          type="button"
          onClick={onExpand}
          className="w-full text-left px-3 pt-2.5 pb-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bambu-green/40"
        >
          <span className="block text-sm text-white whitespace-pre-wrap break-words line-clamp-3">
            {project.description}
          </span>
        </button>
      ) : (
        <div className="px-3 pt-2.5 pb-1.5">
          <p className="text-sm text-white whitespace-pre-wrap break-words line-clamp-3">
            {project.description}
          </p>
        </div>
      )}

      <div className="px-3 pb-2 flex items-center justify-between">
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
