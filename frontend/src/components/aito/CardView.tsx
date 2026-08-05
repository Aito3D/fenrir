import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Building2, GripVertical, Lock, User } from 'lucide-react';
import { TaskMiniRows } from './TaskMiniRows';
import type { AitoProject } from '../../api/client';
import { formatElapsedTime, parseUTCDate } from '../../utils/date';
import { prefersReducedMotion } from '../../utils/motion';
import { ageAnchor, agingTextCls } from '../../utils/aitoAging';

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
  /** An extra bit of text in the footer, beside the steps count. Exists for
   *  the trash grid, where "created 3 weeks ago" is not the fact you are
   *  looking for — "deleted yesterday" is. Every other surface omits it. */
  footerNote?: ReactNode;
  /** A card the server has not acknowledged yet. Renders dimmed with no grip
   *  and no actions: its id does not exist, so anything acting on it would act
   *  on nothing. Cleared the instant the real row replaces it. */
  placeholder?: boolean;
}

/** How long the pointer must rest on a card before its description opens.
 *
 *  Two seconds, not one. A second sounds deliberate but is shorter than the
 *  ordinary act of moving onto a card and clicking it, so every click was
 *  preceded by the card growing and then — the instant the panel took the
 *  pointer — shrinking back. The dwell has to be longer than aiming takes, or
 *  the reveal stops being something you ask for and becomes something that
 *  happens to you. Pressing cancels it outright; see `cancelHoverIntent`. */
const HOVER_REVEAL_MS = 2000;

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
 *  Two zones: the name row carries the client name, the aging timestamp and
 *  is the ONLY drag source (via the grip) — it sits flat on the card surface,
 *  no header band beneath it; everything below it — description, per-task
 *  rows, money, quote number, sync indicator, the steps count, and the
 *  padding between them — is a single click region that opens the detail
 *  panel. There is no edge progress bar; the footer's steps count carries
 *  that total instead. The click handler lives on that region's wrapper
 *  `<div>`, not on a `<button>` wrapping the content: the footer holds the
 *  parent-injected action buttons, and a `<button>` may not contain another.
 *  Every click inside the region — on text, on a task row, or on bare
 *  padding — bubbles to the wrapper because the wrapper is a genuine DOM
 *  ancestor of all of it. A transparent
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
  footerNote,
  placeholder = false,
}: CardViewProps) {
  const { t, i18n } = useTranslation();
  // Normalised once, because a server older than this bundle sends no
  // `task_steps` at all and the type cannot know that. The field is required by
  // the current API contract, but the contract only binds a server that has
  // shipped: `npm run build` writes into ../static/ for the same FastAPI
  // process to serve, so a cached bundle newer than the running server — or a
  // dev frontend proxying to a stale backend — really does deliver `undefined`
  // here. Left bare it threw on `.length`, and one card's throw unmounts the
  // whole board, not just that card. Degrading to "no step rows" is the cheap
  // half of that trade.
  const taskSteps = project.task_steps ?? [];

  // Same building/person distinction the expanded card's header makes.
  const ClientIcon = project.client_is_company ? Building2 : User;

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
    setShellHeight(null);
  }, [clearTimer]);

  // Grow into the reveal instead of jumping to it. The dwell is two seconds
  // long — deliberately longer than aiming at the card takes — so by the time
  // this fires the user is holding still and looking straight at it, which is
  // the worst possible moment to teleport. `shellHeight` is the collapsed
  // height, already measured by the timer above before the state flipped, so
  // both ends of the tween are known and nothing has to be guessed.
  //
  // A layout effect, and WAAPI rather than a CSS transition, for the same two
  // reasons `useFlipReorder` uses them: the animation has to be in flight
  // before the browser paints the expanded height, and inline styles would
  // fight the card's own Tailwind transition on transform/box-shadow — which
  // is what carries the lift and the shadow at the same time.
  //
  // Only the opening is animated. On leave the pointer has already moved on,
  // and a card still shrinking under the NEXT card's hover is worse than one
  // that is simply gone.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!expanded || !card || shellHeight === null) return;
    if (typeof card.animate !== 'function' || prefersReducedMotion()) return;
    const target = card.offsetHeight;
    // Nothing to travel: the reveal only fires when the description is
    // clipped, but a one-word overflow can round to the same height.
    if (target <= shellHeight) return;
    card.animate([{ height: `${shellHeight}px` }, { height: `${target}px` }], {
      // Fast for an entrance (the 250ms budget is for things arriving from
      // off-screen); this box is already there and is only changing size, and
      // the text inside it is being read, so it must settle promptly.
      duration: 200,
      // easeOutQuint — var(--ease-signature) in index.css.
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    });
  }, [expanded, shellHeight]);


  const created = parseUTCDate(project.created_at);
  const updated = parseUTCDate(project.updated_at);
  // Which stamp the age runs from, and its label, now live in utils/aitoAging
  // so this card and the panel it morphs into read the same rule. `created`
  // above is still the raw creation date for the tooltip, which is a different
  // question from "how old is this job".
  const age = ageAnchor(project);
  const elapsed = formatElapsedTime(age.raw, t);
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
      // A press states an intent to OPEN the card, which is the opposite of
      // wanting to read it where it lies — so it abandons the reveal outright,
      // pending or already open. Two things depend on that. The card has to be
      // back to its collapsed size before the click starts the morph, or the
      // panel grows out of a box the wrong size. And since the timer only
      // restarts on mouseenter, a cancelled reveal stays cancelled until the
      // pointer genuinely leaves and comes back, rather than being postponed by
      // one more dwell.
      onPointerDown={endHoverIntent}
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
        // overflow-hidden clips the grip's hover highlight to the card's
        // rounded corner. The name row's `px-3 pt-2.5` padding minus the
        // grip's `-m-2` pull leaves it only ~4px inset from the top-right
        // corner — well inside the 12px `rounded-xl` radius — so the
        // highlight's own square corner (`rounded-md`) would poke past the
        // card's curve there without this. Safe otherwise: the focus ring is
        // `focus-visible:ring-inset` (drawn inside), and `card-shadow` is a
        // box-shadow, which `overflow` does not clip.
        className={`group rounded-xl border bg-bambu-dark-secondary select-none overflow-hidden ${
          expanded ? 'absolute inset-x-0 top-0 z-30 shadow-2xl' : 'relative'
        } ${
          overlay
            ? 'rotate-1 scale-[1.02] border-bambu-green/40 shadow-2xl cursor-grabbing'
            : 'border-bambu-dark-tertiary card-shadow transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:border-bambu-green/40 hover:shadow-lg motion-reduce:hover:translate-y-0'
        } ${placeholder ? 'opacity-60' : ''} ${project.urgent ? 'animate-urgent-halo' : ''}`}
      >
        <div className="flex items-center gap-2 px-3 pt-2.5">
          {/* `aria-hidden` with the label carried in text beside it, so the
              split is not sighted-users-only; null reads as an individual,
              matching the panel. strokeWidth 2.5 to match the medium weight
              of the name. */}
          <ClientIcon
            className={`w-3.5 h-3.5 flex-shrink-0 ${project.client_name ? 'text-white' : 'text-bambu-gray'}`}
            strokeWidth={2.5}
            aria-hidden="true"
          />
          <p
            className={`flex-1 min-w-0 text-sm font-semibold tracking-[-0.01em] truncate ${
              project.client_name ? 'text-white' : 'text-bambu-gray'
            }`}
          >
            <span className="sr-only">
              {project.client_is_company ? t('aito.companyNameLabel') : t('aito.clientNameLabel')}{' '}
            </span>
            {project.client_name ?? t('aito.noClient')}
          </p>
          {/* The chip is what keeps the signal from being colour-only. The halo
              alone is invisible to a colourblind operator, and this is a board
              where missing "urgent" costs real money.
              Dark text on the amber, not white: white on amber-400 is a ~1.9:1
              pair and this chip is 8px bold uppercase — the one place on the
              card with no contrast to spare. A fixed neutral rather than a
              theme token, because the fill is fixed too: `bambu-dark` follows
              --bg-primary and would go near-white under a light theme, putting
              us back at white on amber. */}
          {project.urgent && (
            <span
              data-testid="aito-card-urgent"
              className="flex-shrink-0 rounded-[.2rem] bg-amber-400 px-1 text-[.6rem] font-bold uppercase tracking-wider text-neutral-900"
            >
              {t('aito.urgent')}
            </span>
          )}
          {/* Moved up from the footer: the name row is where a person's eye
              already lands, and an aging job is exactly the fact that belongs
              beside the name, not buried under a description. Heat ramp with
              age — see utils/aitoAging. */}
          <span
            data-testid="aito-card-elapsed"
            title={dateTitle}
            className={`text-xs flex-shrink-0 ${agingTextCls(project, age.at)}`}
          >
            {elapsed}
          </span>
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

        {/* One click region: the body and the footer. The handler is on
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
                  expanded ? '' : 'line-clamp-2'
                }`}
              >
                {project.description}
              </p>
              {/* No money here. A price is read once, deliberately, on the
                  project you have opened; the collapsed card is for reading
                  progress at a glance down a whole column, and a column of
                  totals competes with the task rows for exactly the attention
                  the rows are there to get. `TaskEditor` shows the project
                  total in the detail panel. */}
              <TaskMiniRows tasks={taskSteps} />
            </div>

            <div className="px-3 pb-2 flex items-center justify-between gap-2">
              <div className="flex items-baseline gap-2 min-w-0">
                {/* Replaces the edge progress bar: the same done/total fact,
                    read as a number instead of a sliver of fill along the
                    card's bottom border. Omitted at zero — a project with no
                    steps yet has nothing to count. */}
                {project.steps_total > 0 && (
                  <span className="text-xs text-bambu-gray tabular-nums flex-shrink-0">
                    {t('aito.stepsCount', { done: project.steps_done, total: project.steps_total })}
                  </span>
                )}
                {footerNote && <span className="text-xs text-bambu-gray truncate">{footerNote}</span>}
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
          </div>
        </div>
      </div>
    </div>
  );
}
