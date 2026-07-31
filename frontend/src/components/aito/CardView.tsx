import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, GripVertical, Lock } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { ProjectProgress } from './ProjectProgress';
import { StepGrid } from './StepGrid';
import type { AitoProject } from '../../api/client';
import { api } from '../../api/client';
import { Money } from '../calculator/shared';
import { formatElapsedTime, parseUTCDate } from '../../utils/date';

export interface CardViewProps {
  project: AitoProject;
  overlay?: boolean;
  onExpand?: () => void;
  /** Footer actions, injected by the parent that owns their mutations —
   *  mark-sent and mark-done from the board's `SortableCard`, restore from the
   *  done grid. Kept as a slot rather than a prop per action because the gates
   *  are column- and surface-specific, and this component is neither: it is the
   *  same card in a column, in the grid, and under the drag overlay. Omitted by
   *  the DragOverlay clone — the overlay is a picture, not a control — and
   *  ignored entirely on a placeholder. */
  actions?: ReactNode;
  /** dnd-kit's setActivatorNodeRef — omitted by the DragOverlay clone. */
  dragHandleRef?: (element: HTMLElement | null) => void;
  /** dnd-kit's attributes + listeners, spread onto the grip. */
  dragHandleProps?: Record<string, unknown>;
  /** A card the server has not acknowledged yet. Renders dimmed with no grip
   *  and no actions: its id does not exist, so anything acting on it would act
   *  on nothing. Cleared the instant the real row replaces it. */
  placeholder?: boolean;
}

/** Presentational card, shared by the in-column sortable wrapper and the
 *  DragOverlay clone.
 *
 *  Three zones with distinct jobs: the header carries the client name and is
 *  the ONLY drag source (via the grip); the body is the only thing that opens
 *  the detail panel; the footer holds the timestamp and whatever actions the
 *  parent injects. Phone, email and delete live in the detail panel, not here.
 *
 *  The footer sits outside the body button because a <button> may not contain
 *  another button. */
export function CardView({
  project,
  overlay = false,
  onExpand,
  actions,
  dragHandleRef,
  dragHandleProps,
  placeholder = false,
}: CardViewProps) {
  const { t, i18n } = useTranslation();
  // Same query key the task editor and the calculator page use for the
  // configured currency, so the card rides their cache instead of adding a
  // fetch per card.
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.getSettings,
    staleTime: 60_000,
  });
  const currency = settings?.currency || 'USD';
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
      // overflow-hidden clips the progress bar to the card's rounded corner.
      // Safe here: the focus ring is `focus-visible:ring-inset` (drawn inside),
      // `card-shadow` is a box-shadow and is not clipped by `overflow`, and the
      // grip's `p-2 -m-2` pulls padding inward rather than pushing content out.
      className={`group relative rounded-xl border bg-bambu-dark-secondary select-none overflow-hidden ${
        overlay
          ? 'rotate-1 scale-[1.02] border-bambu-green/40 shadow-2xl cursor-grabbing'
          : 'border-bambu-dark-tertiary card-shadow transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:border-bambu-green/40 hover:shadow-lg motion-reduce:hover:translate-y-0'
      } ${placeholder ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center gap-2 px-3 py-2 bg-bambu-dark-tertiary rounded-t-xl border-b border-bambu-dark-secondary">
        <p
          className={`flex-1 text-sm font-medium truncate ${
            project.client_name ? 'text-white' : 'text-bambu-gray'
          }`}
        >
          {project.client_name ?? t('aito.noClient')}
        </p>
        {dragHandleProps && !placeholder ? (
          <button
            type="button"
            ref={dragHandleRef}
            aria-label={t('aito.dragHandle')}
            {...dragHandleProps}
            // touch-none belongs on the grip, not the card: on the card it
            // would block touch-scrolling the column from anywhere on a card.
            className="touch-none flex-shrink-0 p-2 -m-2 rounded-md text-bambu-gray cursor-grab active:cursor-grabbing hover:text-white hover:bg-bambu-dark-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"
          >
            <GripVertical className="w-4 h-4" />
          </button>
        ) : (
          <GripVertical className="w-4 h-4 flex-shrink-0 text-bambu-gray" aria-hidden="true" />
        )}
      </div>

      {onExpand && !placeholder ? (
        <button
          type="button"
          onClick={onExpand}
          className="block w-full text-left px-3 pt-2.5 pb-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bambu-green/40"
        >
          <span className="block text-sm text-white whitespace-pre-wrap break-words line-clamp-3">
            {project.description}
          </span>
          <StepGrid tasks={project.task_steps} />
          {project.task_steps.length > 0 && (
            <span className="mt-1 flex justify-end">
              <Money currency={currency} value={project.tasks_total} className="text-xs font-medium text-bambu-green" />
            </span>
          )}
        </button>
      ) : (
        <div className="px-3 pt-2.5 pb-1.5">
          <p className="text-sm text-white whitespace-pre-wrap break-words line-clamp-3">
            {project.description}
          </p>
          <StepGrid tasks={project.task_steps} />
          {project.task_steps.length > 0 && (
            <div className="mt-1 flex justify-end">
              <Money currency={currency} value={project.tasks_total} className="text-xs font-medium text-bambu-green" />
            </div>
          )}
        </div>
      )}

      <div className="px-3 pb-2 flex items-center justify-between gap-2">
        <span className="flex items-baseline gap-2 min-w-0">
          <span className="text-xs text-bambu-gray flex-shrink-0" title={dateTitle}>
            {elapsed}
          </span>
          {/* Imported cards carry their quote number here. A plain span, not a
              link: the deep link lives in the detail panel, and the footer
              already holds hold-to-delete. */}
          {project.quote_number && (
            <span className="text-xs text-bambu-gray truncate">{project.quote_number}</span>
          )}
          {/* A project whose quote the worker has not created yet. Without
              this the card is indistinguishable from one that will never have
              a quote, which is exactly the wrong thing to say for a few
              seconds after every create. */}
          {!project.quote_number && project.quote_sync_state === 'pending' && (
            <span className="text-xs text-bambu-gray/70 truncate italic">{t('aito.quotePending')}</span>
          )}
          {(project.quote_sync_state === 'error' || project.quote_sync_state === 'locked') && (
            <span
              aria-label={project.quote_sync_state === 'error' ? t('aito.syncError') : t('aito.quoteLocked')}
              title={project.quote_sync_error || undefined}
              className="flex-shrink-0 text-bambu-gray"
            >
              {project.quote_sync_state === 'error' ? (
                <AlertTriangle className="w-3.5 h-3.5" />
              ) : (
                <Lock className="w-3.5 h-3.5" />
              )}
            </span>
          )}
        </span>
        <span className="flex items-center gap-1 flex-shrink-0">{!overlay && !placeholder && actions}</span>
      </div>
      <ProjectProgress done={project.steps_done} total={project.steps_total} />
    </div>
  );
}
