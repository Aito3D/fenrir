import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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

/** How long the pointer must rest on a card before its description opens.
 *
 *  A second is long enough that crossing the board never triggers it and
 *  short enough to feel like an answer rather than a wait. */
const HOVER_REVEAL_MS = 1000;

/** Presentational card, shared by the in-column sortable wrapper and the
 *  DragOverlay clone.
 *
 *  The outermost element is a shell, not the card: it holds the collapsed
 *  height so the column never reflows while the card itself floats over its
 *  neighbours to reveal a clamped description (see the hover-intent state
 *  below). The shell carries no card styling and none of the
 *  `data-aito-card*` attributes — those stay on the card element inside it,
 *  because `useCardMorph` queries `[data-aito-card-id]` to assign the view
 *  transition name and must keep finding the styled element, not empty space.
 *
 *  Two zones: the header carries the client name and is the ONLY drag source
 *  (via the grip); everything below it — description, step pills, money,
 *  elapsed time, quote number, sync indicator, progress bar, and the padding
 *  between them — is a single click region that opens the detail panel. The
 *  click handler lives on that region's wrapper `<div>`, not on a `<button>`
 *  wrapping the content: the footer holds the parent-injected action buttons,
 *  and a `<button>` may not contain another. Every click inside the region —
 *  on text, on a step pill, or on bare padding — bubbles to the wrapper
 *  because the wrapper is a genuine DOM ancestor of all of it. A transparent
 *  `<button>` sits underneath purely as the pointerless affordance: it carries
 *  the accessible name and the focus ring, and the click its Enter/Space
 *  produces bubbles to the same wrapper handler, so keyboard and pointer
 *  share one path with nothing to double-fire. The parent-injected actions
 *  (mark-sent, mark-done, restore, hold-to-delete) opt out by stopping
 *  propagation, so their own clicks never reach the region handler. Phone,
 *  email and delete live in the detail panel, not here. */
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

  // Hover-intent reveal of a clamped description. The card floats over its
  // neighbours rather than growing in place: the shell holds the collapsed
  // height so the column never reflows, which is what stops the cards below
  // jumping out from under the pointer that is resting on this one.
  const [expanded, setExpanded] = useState(false);
  const [shellHeight, setShellHeight] = useState<number | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const descriptionRef = useRef<HTMLParagraphElement>(null);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // A card can be unmounted mid-hover by a refetch, a filter or a drag.
  useEffect(() => clearTimer, [clearTimer]);

  const startHoverIntent = useCallback(() => {
    // The overlay is a picture of a card mid-drag and a placeholder has no id
    // yet; neither should grow under the pointer.
    if (overlay || placeholder) return;
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const description = descriptionRef.current;
      const card = cardRef.current;
      if (!description || !card) return;
      // Nothing hidden means nothing to reveal. The +1 absorbs the sub-pixel
      // rounding a fractional line-height leaves behind.
      if (description.scrollHeight <= description.clientHeight + 1) return;
      setShellHeight(card.offsetHeight);
      setExpanded(true);
    }, HOVER_REVEAL_MS);
  }, [clearTimer, overlay, placeholder]);

  const endHoverIntent = useCallback(() => {
    clearTimer();
    setExpanded(false);
  }, [clearTimer]);

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
      data-testid="aito-card-shell"
      onMouseEnter={startHoverIntent}
      onMouseLeave={endHoverIntent}
      // The shell holds the collapsed height while the card floats, so the
      // column's layout does not change. It carries no card styling and no
      // `data-aito-card*` — it is space, nothing else.
      className="relative"
      style={expanded && shellHeight !== null ? { height: shellHeight } : undefined}
    >
      <div
        ref={cardRef}
        data-aito-card
        data-aito-card-id={project.id}
        // overflow-hidden clips the progress bar to the card's rounded corner.
        // Safe here: the focus ring is `focus-visible:ring-inset` (drawn inside),
        // `card-shadow` is a box-shadow and is not clipped by `overflow`, and the
        // grip's `p-2 -m-2` pulls padding inward rather than pushing content out.
        className={`group rounded-xl border bg-bambu-dark-secondary select-none overflow-hidden ${
          expanded ? 'absolute inset-x-0 top-0 z-30 shadow-2xl' : 'relative'
        } ${
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

        {/* One click region: the body, the footer and the bar. The handler is on
            this wrapper rather than on a <button> wrapping everything, because
            the footer holds the parent's injected action buttons and a <button>
            may not contain another. Every click inside bubbles to here.

            The transparent button underneath is what makes that reachable
            without a pointer: it carries the accessible name and the focus ring,
            and the click its Enter/Space produces bubbles to this same handler.
            It sits at z-0 beneath `relative z-10` content, so the content keeps
            its own hover, cursor and tooltips and the button only takes the
            clicks that land on bare padding. */}
        <div className="relative" onClick={onExpand && !placeholder ? onExpand : undefined}>
          {onExpand && !placeholder && (
            <button
              type="button"
              // The description IS the accessible name — it is what the card is
              // about, and it saves inventing a label key for 13 locales.
              aria-label={project.description || (project.client_name ?? t('aito.noClient'))}
              className="absolute inset-0 z-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bambu-green/40"
            />
          )}

          <div className="relative z-10">
            <div className="px-3 pt-2.5 pb-1.5">
              <p
                ref={descriptionRef}
                data-testid="aito-card-description"
                className={`text-sm text-white whitespace-pre-wrap break-words ${
                  expanded ? '' : 'line-clamp-3'
                }`}
              >
                {project.description}
              </p>
              <StepGrid tasks={project.task_steps} />
              {project.task_steps.length > 0 && (
                <div className="mt-1 flex justify-end">
                  <Money
                    currency={currency}
                    value={project.tasks_total}
                    className="text-xs font-medium text-bambu-green"
                  />
                </div>
              )}
            </div>

            <div className="px-3 pb-2 flex items-center justify-between gap-2">
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="text-xs text-bambu-gray flex-shrink-0" title={dateTitle}>
                  {elapsed}
                </span>
                {project.quote_number && (
                  <span className="text-xs text-bambu-gray truncate">{project.quote_number}</span>
                )}
                {/* A project whose quote the worker has not created yet. Without
                    this the card is indistinguishable from one that will never
                    have a quote, which is exactly the wrong thing to say for a
                    few seconds after every create. */}
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
              </div>
              {/* The one region that is NOT a way to open the card: these are
                  real controls, so their clicks must not also reach the region
                  handler above. */}
              <div
                className="flex items-center gap-1 flex-shrink-0"
                onClick={(event) => event.stopPropagation()}
              >
                {!overlay && !placeholder && actions}
              </div>
            </div>

            <ProjectProgress done={project.steps_done} total={project.steps_total} />
          </div>
        </div>
      </div>
    </div>
  );
}
