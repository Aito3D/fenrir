import type { ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { GripVertical } from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { TaskRow } from './TaskRow';
import { focusRingCls } from '../formStyles';
import { useReducedMotion } from '../../hooks/useReducedMotion';

/** House travel curve — var(--ease-signature) — for the siblings sliding out
 *  of the dragged card's way. dnd-kit needs the literal value: it writes an
 *  inline `transition`, which cannot resolve a CSS custom property from JS. */
const SORT_TRANSITION = { duration: 250, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' };

interface SortableTaskRowProps extends ComponentProps<typeof TaskRow> {
  /** dnd-kit item id — the row's `rowKey` (server id or draft uid). */
  sortId: string;
  /** Handle visibility is a separate question from sortability: rows stay
   *  registered in the SortableContext (stable ids, no remounts) even while
   *  reordering is momentarily unavailable (single row, pending create). */
  showHandle: boolean;
}

/** One sortable slot of TaskEditor's list: owns the dnd-kit wiring (node ref,
 *  transform, transition, the activator handle) and passes the row itself
 *  straight through to TaskRow, which stays presentational. */
export function SortableTaskRow({ sortId, showHandle, ...rowProps }: SortableTaskRowProps) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: sortId,
    transition: reducedMotion ? null : SORT_TRANSITION,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition: transition ?? undefined }}
      className={isDragging ? 'relative z-10 will-change-transform' : undefined}
    >
      <TaskRow
        {...rowProps}
        dragging={isDragging}
        dragHandle={
          showHandle ? (
            <button
              type="button"
              ref={setActivatorNodeRef}
              {...attributes}
              {...listeners}
              aria-label={t('aito.reorderTask')}
              title={t('aito.reorderTask')}
              // `touch-none` is load-bearing: without it a touch drag scrolls
              // the panel instead of moving the card.
              className={`flex-shrink-0 touch-none p-1 -m-1 rounded-md transition-colors motion-reduce:transition-none ${focusRingCls} ${
                isDragging ? 'cursor-grabbing text-white' : 'cursor-grab text-bambu-gray hover:text-white'
              }`}
            >
              <GripVertical className="w-3.5 h-3.5" />
            </button>
          ) : undefined
        }
      />
    </div>
  );
}
