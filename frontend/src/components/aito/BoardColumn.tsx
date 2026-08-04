import { useCallback, useRef } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTranslation } from 'react-i18next';
import { Check, Send } from 'lucide-react';
import { CardView } from './CardView';
import { HoldButton } from './HoldButton';
import type { ColumnMeta } from './columns';
import type { AitoProject } from '../../api/client';
import { useColumnMoveMutation } from '../../hooks/useColumnMoveMutation';
import { useQuoteStatusMutation } from '../../hooks/useQuoteStatusMutation';
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
  const { t } = useTranslation();

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

  // Owned here rather than threaded down from AitoPage: the hook is
  // per-project, and this component is already the one-per-project layer.
  // Hoisting it to the board would mean either one mutation per column (wrong
  // project) or a lookup by id (a second source of truth for which project a
  // card is).
  const markSent = useQuoteStatusMutation(project);

  // Finish's counterpart to the Quote column's mark-sent: the board's only
  // other manual transition, and the only way to reach Done now that the
  // column itself is off the board.
  const markDone = useColumnMoveMutation(project, 'done');

  // A card that just snapped back. The ring lives on this wrapper rather than
  // on CardView so the DragOverlay clone — which renders CardView directly —
  // never inherits it.
  const reverting = useIsReverting(project.id);

  return (
    <div
      ref={setNodeRef}
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
        actions={
          <>
            {project.column === 'devis' && (
              // The Quote column's one real action, on the card so the column
              // can be cleared without opening anything. Deliberately NOT
              // hidden behind group-hover the way delete is: delete hides
              // because a destructive action should be hard to hit by
              // accident, and this is the opposite — the primary action of the
              // column, which an invisible button cannot be. `project.column`
              // is the server's derived value (aito_board_rules.evaluate); the
              // frontend derives nothing of its own here.
              <HoldButton
                onHold={() => markSent.mutate('sent')}
                durationMs={500}
                disabled={markSent.isPending}
                label={t('aito.markSent')}
                hint={t('aito.holdToConfirm')}
                progress="perimeter"
                className="p-1 -m-1 text-amber-400/70 hover:text-amber-400 hover:bg-amber-400/10 focus-visible:ring-amber-400/40 data-[holding=true]:text-amber-400"
              >
                <Send className="relative w-3.5 h-3.5" />
              </HoldButton>
            )}
            {project.column === 'finish' && project.move_lock === null && (
              // Both halves of the gate matter. The column is where the card
              // has to be; `move_lock === null` is the rules' own release, and
              // it is what keeps this off a declined quote — those sit in Done
              // with move_lock 'declined', and the endpoint would refuse.
              <HoldButton
                onHold={() => markDone.mutate()}
                durationMs={500}
                disabled={markDone.isPending}
                label={t('aito.markProjectDone')}
                hint={t('aito.holdToConfirm')}
                progress="perimeter"
                // invoiced = the job is billed; the glow is the board saying
                // "archive me" without forcing the move. The color class is a
                // swap, not an addition: `text-bambu-green` and
                // `text-bambu-green/70` share specificity, so appending the
                // full-color class alongside the /70 one would leave the
                // opacity variant winning in the generated CSS.
                className={`p-1 -m-1 hover:text-bambu-green hover:bg-bambu-green/10 focus-visible:ring-bambu-green/40 data-[holding=true]:text-bambu-green ${
                  project.quote_invoiced ? 'animate-invoiced-glow text-bambu-green' : 'text-bambu-green/70'
                }`}
              >
                <Check className="relative w-3.5 h-3.5" />
              </HoldButton>
            )}
          </>
        }
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
      className={`w-72 sm:w-80 lg:w-full lg:min-w-0 flex-shrink-0 flex flex-col rounded-xl bg-bambu-dark-secondary/40 border transition-[border-color,box-shadow,opacity] duration-150 ${
        isDropTarget ? `border-transparent ring-2 ${column.ring}` : 'border-bambu-dark-tertiary'
      } ${dropDisabled ? 'opacity-40' : ''}`}
    >
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-bambu-dark-tertiary/60">
        <span className={`w-2 h-2 rounded-full ${column.dot}`} />
        <h2 className="text-sm font-semibold text-white flex-1 truncate">{t(column.labelKey)}</h2>
        <span
          key={projects.length}
          className="min-w-[1.5rem] px-1.5 py-0.5 text-center text-xs font-medium text-bambu-gray-light bg-bambu-dark-tertiary rounded-full tabular-nums animate-value-tick"
        >
          {projects.length}
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
          {projects.length === 0 && (
            <div className="flex-1 min-h-[8rem] rounded-lg border border-dashed border-bambu-dark-tertiary/80" />
          )}
        </div>
      </SortableContext>
    </div>
  );
}
