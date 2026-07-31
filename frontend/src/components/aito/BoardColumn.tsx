import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTranslation } from 'react-i18next';
import { Send } from 'lucide-react';
import { CardView } from './CardView';
import { HoldButton } from './HoldButton';
import type { ColumnMeta } from './columns';
import type { AitoProject } from '../../api/client';
import { useQuoteStatusMutation } from '../../hooks/useQuoteStatusMutation';
import { useIsReverting } from '../../hooks/useRevertFlash';
import { isPlaceholder } from '../../utils/aitoOptimistic';

function SortableCard({
  project,
  onExpand,
  transitionConfig,
  animateIn,
}: {
  project: AitoProject;
  onExpand: () => void;
  transitionConfig: { duration: number; easing: string } | null;
  animateIn: boolean;
}) {
  // Every card is grabbable, including a rule-locked one: reordering inside a
  // column changes priority, not state, and both `allowedColumns` and the
  // server's move endpoint permit it. What a locked card cannot do is LEAVE
  // its column — `useBoardDrag`'s `isDropAllowed` refuses that drop, and the
  // board dims the columns that will refuse it.
  const placeholder = isPlaceholder(project);
  const { t } = useTranslation();

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
    disabled: placeholder,
  });

  // Owned here rather than threaded down from AitoPage: the hook is
  // per-project, and this component is already the one-per-project layer.
  // Hoisting it to the board would mean either one mutation per column (wrong
  // project) or a lookup by id (a second source of truth for which project a
  // card is).
  const markSent = useQuoteStatusMutation(project);

  // A card that just snapped back. The ring lives on this wrapper rather than
  // on CardView so the DragOverlay clone — which renders CardView directly —
  // never inherits it.
  const reverting = useIsReverting(project.id);

  return (
    <div
      ref={setNodeRef}
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
          project.column === 'devis' ? (
            // The Quote column's one real action, on the card so the column can
            // be cleared without opening anything. Deliberately NOT hidden
            // behind group-hover the way delete is: delete hides because a
            // destructive action should be hard to hit by accident, and this is
            // the opposite — the primary action of the column, which an
            // invisible button cannot be. `project.column` is the server's
            // derived value (aito_board_rules.evaluate); the frontend derives
            // nothing of its own here.
            <HoldButton
              onHold={() => markSent.mutate('sent')}
              durationMs={500}
              disabled={markSent.isPending}
              label={t('aito.markSent')}
              hint={t('aito.holdToConfirm')}
              className="p-1 -m-1 text-amber-400/70 hover:text-amber-400 hover:bg-amber-400/10 focus-visible:ring-amber-400/40 data-[holding=true]:text-amber-400"
            >
              <Send className="relative w-3.5 h-3.5" />
            </HoldButton>
          ) : null
        }
        dragHandleRef={setActivatorNodeRef}
        dragHandleProps={{ ...attributes, ...listeners }}
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
}

export function BoardColumn({
  column,
  projects,
  isDropTarget,
  onExpandCard,
  transitionConfig,
  shouldAnimateIn,
  dropDisabled,
}: ColumnProps) {
  const { t } = useTranslation();
  const { setNodeRef } = useDroppable({ id: column.id, disabled: dropDisabled });

  return (
    <div
      // The dim is purely visual — `useDroppable({ disabled })` above is what
      // actually refuses the drop. It tells the user, mid-drag, which columns
      // this card may land in: only its own for a rule-locked card, Finish and
      // Done for a released one.
      className={`w-72 sm:w-80 flex-shrink-0 flex flex-col rounded-xl bg-bambu-dark-secondary/40 border transition-[border-color,box-shadow,opacity] duration-150 ${
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
        <div ref={setNodeRef} className="flex-1 flex flex-col gap-2 p-2 min-h-[10rem] overflow-y-auto">
          {projects.map((project) => (
            <SortableCard
              key={project.id}
              project={project}
              onExpand={() => onExpandCard(project.id)}
              transitionConfig={transitionConfig}
              animateIn={shouldAnimateIn(project.id)}
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
