import { useTranslation } from 'react-i18next';
import { AlertTriangle, GripVertical, Lock } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { DeleteHoldButton } from './DeleteHoldButton';
import { ServiceBadges } from './ServiceBadges';
import { quoteStatusLabelKey, quoteStatusStyle } from './quoteStatus';
import type { AitoProject } from '../../api/client';
import { api } from '../../api/client';
import { Money } from '../calculator/shared';
import { formatElapsedTime, parseUTCDate } from '../../utils/date';

// Module scope: a plain object literal, identical on every render, so it
// need not be reconstructed (and re-diffed by anything memoizing on it)
// each time the card renders.
const LOCK_LABEL_KEYS = {
  quote: 'aito.lockedQuote',
  waiting: 'aito.lockedWaiting',
  declined: 'aito.lockedDeclined',
  steps: 'aito.lockedSteps',
} as const;

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

  // A locked card has no grip: the lock takes its place in the header. The
  // rules decide where the card sits, so a grip there could only lift it and
  // put it straight back — an affordance that promises a move it will always
  // refuse. The badge's title says why it cannot be moved.
  const lockTitle = project.move_lock ? t(LOCK_LABEL_KEYS[project.move_lock]) : null;

  // Every element here is phrasing content (<span>, and Money renders a
  // <span>): this block is rendered INSIDE the body <button>, and a <button>
  // may not contain <div> or <p>. Keeping it inside the button is deliberate —
  // it makes the whole content area one target that opens the panel.
  const summary =
    project.task_count > 0 ? (
      <span className="mt-2 block">
        <ServiceBadges services={project.task_services} />
        <span className="mt-1 flex items-baseline justify-between gap-2">
          <span className="text-xs text-bambu-gray">{t('aito.taskCount', { count: project.task_count })}</span>
          <Money currency={currency} value={project.tasks_total} className="text-xs font-medium text-bambu-green" />
        </span>
      </span>
    ) : null;

  return (
    <div
      data-aito-card
      data-aito-card-id={project.id}
      className={`group relative rounded-xl border bg-bambu-dark-secondary select-none ${
        overlay
          ? 'rotate-1 scale-[1.02] border-bambu-green/40 shadow-2xl cursor-grabbing'
          : 'border-bambu-dark-tertiary card-shadow transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:border-bambu-green/40 hover:shadow-lg motion-reduce:hover:translate-y-0'
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-2 bg-bambu-dark-tertiary rounded-t-xl border-b border-bambu-dark-secondary">
        <p
          className={`flex-1 text-sm font-medium truncate ${
            project.client_name ? 'text-white' : 'text-bambu-gray'
          }`}
        >
          {project.client_name ?? t('aito.noClient')}
        </p>
        {lockTitle ? (
          <span
            title={lockTitle}
            role="img"
            aria-label={lockTitle}
            className="flex-shrink-0 p-2 -m-2 text-bambu-gray"
          >
            <Lock className="w-4 h-4" aria-hidden="true" />
          </span>
        ) : dragHandleProps ? (
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

      {onExpand ? (
        <button
          type="button"
          onClick={onExpand}
          className="block w-full text-left px-3 pt-2.5 pb-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bambu-green/40"
        >
          <span className="block text-sm text-white whitespace-pre-wrap break-words line-clamp-3">
            {project.description}
          </span>
          {summary}
        </button>
      ) : (
        <div className="px-3 pt-2.5 pb-1.5">
          <p className="text-sm text-white whitespace-pre-wrap break-words line-clamp-3">
            {project.description}
          </p>
          {summary}
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
          {/* The status as it stood at import — a snapshot, like the rest of
              the quote fields, so it can lag what Zoho says today. Colour
              carries the meaning; the label is there for anyone who cannot
              rely on it. */}
          {project.quote_status && (
            <span
              className={`text-[10px] leading-tight rounded px-1.5 py-0.5 flex-shrink-0 ${quoteStatusStyle(
                project.quote_status,
              )}`}
            >
              {(() => {
                const key = quoteStatusLabelKey(project.quote_status);
                return key ? t(key) : project.quote_status;
              })()}
            </span>
          )}
        </span>
        {onDelete && (
          <DeleteHoldButton onDelete={onDelete} label={t('aito.deleteTitle')} hint={t('aito.holdToDelete')} />
        )}
      </div>
    </div>
  );
}
