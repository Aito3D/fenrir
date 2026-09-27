import { useCallback, useRef } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTranslation } from 'react-i18next';
import { CardView } from './CardView';
import { BoardCardActions } from './BoardCardActions';
import type { ColumnMeta } from './columns';
import type { AitoProject } from '../../api/client';
import { useColumnReflow } from '../../hooks/useColumnReflow';
import { useIsReverting } from '../../hooks/useRevertFlash';
import { isPlaceholder } from '../../utils/aitoOptimistic';

function SortableCard({
  project,
  onExpand,
  transitionConfig,
  animateIn,
  dragDisabled,
}: {
  project: AitoProject;
  onExpand: () => void;
  transitionConfig: { duration: number; easing: string } | null;
  animateIn: boolean;
  dragDisabled?: boolean;
}) {
  // Every card is grabbable, including a rule-locked one: reordering inside a
  // column changes priority, not state, and both `allowedColumns` and the
  // server's move endpoint permit it. What a locked card cannot do is LEAVE
  // its column — `useBoardDrag`'s `isDropAllowed` refuses that drop, and the
  // board dims the columns that will refuse it.
  const placeholder = isPlaceholder(project);

  // A card cannot be dragged while the board is filtered: `computeMoveTarget`
  // derives the persisted position from the card's index in the column it is
  // handed, and with cards hidden that index is not the real position. Also
  // covers the placeholder case, whose id does not exist yet.
  const dragLocked = placeholder || Boolean(dragDisabled);

  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: project.id,
    transition: transitionConfig,
    disabled: dragLocked,
  });

  // The card's own node, for the celebration to fire out of. dnd-kit's
  // `setNodeRef` is a callback ref, so the two are composed rather than
  // assigned — the same pattern `BoardColumn` uses below for the droppable
  // and the reflow ref.
  const cardRef = useRef<HTMLDivElement | null>(null);
  const setCardRef = useCallback(
    (node: HTMLDivElement | null) => {
      cardRef.current = node;
      setNodeRef(node);
    },
    [setNodeRef],
  );

  // A card that just snapped back. The ring lives on this wrapper rather than
  // on CardView so the DragOverlay clone — which renders CardView directly —
  // never inherits it.
  const reverting = useIsReverting(project.id);

  return (
    <div
      ref={setCardRef}
      // Read by `useColumnReflow` on the column below, so a card that stays
      // when its neighbours are filtered away slides into the gap instead of
      // teleporting. The id, not the index: the index is what changes.
      data-flip-key={project.id}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`${animateIn ? 'animate-rise' : ''} ${isDragging ? 'opacity-30' : ''} ${
        reverting ? 'animate-revert-flash' : ''
      }`}
    >
      <CardView
        project={project}
        placeholder={placeholder}
        onExpand={onExpand}
        actions={<BoardCardActions project={project} cardRef={cardRef} />}
        dragHandleRef={setActivatorNodeRef}
        // Undefined, not disabled: CardView already renders an inert grip on
        // this path — it is how the DragOverlay clone renders — so a filtered
        // card becomes undraggable with no new markup and no dead button in
        // the tab order.
        dragHandleProps={dragLocked ? undefined : { ...attributes, ...listeners }}
      />
    </div>
  );
}

interface ColumnProps {
  column: ColumnMeta;
  projects: AitoProject[];
  isDropTarget: boolean;
  onExpandCard: (id: number) => void;
  transitionConfig: { duration: number; easing: string } | null;
  shouldAnimateIn: (id: number) => boolean;
  dropDisabled?: boolean;
  // Board-wide: a search query is active, so no card's index reflects its
  // real position. Distinct from `dropDisabled`, which is per-column and only
  // meaningful mid-drag.
  dragDisabled?: boolean;
  // A drag is in progress anywhere on the board. Suspends the reflow slide:
  // dnd-kit is already transforming these same nodes, and two systems
  // animating one element fight visibly. Optional so a caller that renders a
  // column outside a drag context need not think about it.
  dragActive?: boolean;
  // The board's first fetch has not answered yet. The column renders in its
  // final place regardless — the layout IS the loading state — but dimmed,
  // with a dash for a count it does not know and no dashed "empty" box,
  // which would claim the column is empty rather than unknown.
  pending?: boolean;
}

export function BoardColumn({
  column,
  projects,
  isDropTarget,
  onExpandCard,
  transitionConfig,
  shouldAnimateIn,
  dropDisabled,
  dragDisabled,
  dragActive = false,
  pending = false,
}: ColumnProps) {
  const { t } = useTranslation();
  // Both reasons a column may refuse a drop: `dropDisabled` is the per-card
  // rule gate during a drag, `dragDisabled` is the board-wide filter.
  //
  // A ternary rather than `dropDisabled || dragDisabled`, because `||`
  // collapses an explicit `false` to `undefined` when the right-hand side is
  // unset — and AitoBoardColumnDrag.test.tsx asserts the exact value passed
  // here, distinguishing `false` (a drag is in progress and this column is
  // allowed) from `undefined` (no drag at all).
  const { setNodeRef } = useDroppable({ id: column.id, disabled: dragDisabled ? true : dropDisabled });

  // The droppable's ref and our own on one node: `useDroppable` hands back a
  // callback ref, so it has to be called rather than assigned, and the reflow
  // hook needs a stable object ref to measure from.
  const cardsRef = useRef<HTMLDivElement | null>(null);
  const setCardsRef = useCallback(
    (node: HTMLDivElement | null) => {
      cardsRef.current = node;
      setNodeRef(node);
    },
    [setNodeRef],
  );
  // `null` while a drag is live — see the `dragActive` prop. The key is the
  // membership AND order of the column, so removing a card, restoring one, or
  // reordering all count as a change worth sliding.
  useColumnReflow(cardsRef, dragActive ? null : projects.map((project) => project.id).join(','));

  return (
    <div
      // The dim is purely visual — `useDroppable({ disabled })` above is what
      // actually refuses the drop. It tells the user, mid-drag, which columns
      // this card may land in: its own, and only its own, for every card.
      // Dragging is reordering now; the one manual cross-column transition
      // (Finish -> Done and back) is the hold buttons above, not a drop.
      // Opacity gets a longer duration than the drag feedback: the brighten
      // when the first data lands is a settle, not a flicker of state.
      className={`w-72 sm:w-80 lg:w-full lg:min-w-0 flex-shrink-0 flex flex-col rounded-xl bg-bambu-dark-secondary/40 border transition-[border-color,box-shadow,opacity] [transition-duration:150ms,150ms,300ms] ${
        isDropTarget ? `border-transparent ring-2 ${column.ring}` : 'border-bambu-dark-tertiary'
      } ${dropDisabled || pending ? 'opacity-40' : ''}`}
      data-pending={pending || undefined}
    >
      {/* The header carries the column's view-transition name so the board
          folds into the statistics strip's matching cell and unfolds on the
          way back (index.css, `vt-aito-col-*`). */}
      <div className={`vt-aito-col-${column.id} flex items-center gap-2 px-3 py-2.5 border-b border-bambu-dark-tertiary/60`}>
        <span className={`w-2 h-2 rounded-full ${column.dot}`} />
        <h2 className="text-sm font-semibold text-white flex-1 truncate">{t(column.labelKey)}</h2>
        <span
          key={pending ? 'pending' : projects.length}
          className={`min-w-[1.5rem] px-1.5 py-0.5 text-center text-xs font-medium bg-bambu-dark-tertiary rounded-full tabular-nums animate-value-tick ${pending ? 'text-bambu-gray' : 'text-bambu-gray-light'}`}
        >
          {pending ? '–' : projects.length}
        </span>
      </div>

      <SortableContext items={projects.map((p) => p.id)} strategy={verticalListSortingStrategy}>
        <div ref={setCardsRef} className="flex-1 flex flex-col gap-2 p-2 min-h-[10rem] overflow-y-auto scrollbar-hide">
          {projects.map((project) => (
            <SortableCard
              key={project.id}
              project={project}
              onExpand={() => onExpandCard(project.id)}
              transitionConfig={transitionConfig}
              animateIn={shouldAnimateIn(project.id)}
              dragDisabled={dragDisabled}
            />
          ))}
          {projects.length === 0 && !pending && (
            // animate-fade-in: the placeholder pops in the instant the last
            // card leaves, while the flight/reflow is carrying the eye —
            // entrance only, no exit, because an arriving card should cover
            // it immediately.
            <div className="animate-fade-in flex-1 min-h-[8rem] rounded-lg border border-dashed border-bambu-dark-tertiary/80" />
          )}
        </div>
      </SortableContext>
    </div>
  );
}
