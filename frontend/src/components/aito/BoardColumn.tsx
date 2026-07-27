import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTranslation } from 'react-i18next';
import { CardView } from './CardView';
import type { ColumnMeta } from './columns';
import type { AitoProject } from '../../api/client';

function SortableCard({
  project,
  onDelete,
  onExpand,
  transitionConfig,
  animateIn,
}: {
  project: AitoProject;
  onDelete: () => void;
  onExpand: () => void;
  transitionConfig: { duration: number; easing: string } | null;
  animateIn: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: project.id,
    transition: transitionConfig,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      className={`touch-none ${animateIn ? 'animate-rise' : ''} ${isDragging ? 'opacity-30' : ''}`}
    >
      <CardView project={project} onDelete={onDelete} onExpand={onExpand} />
    </div>
  );
}

interface ColumnProps {
  column: ColumnMeta;
  projects: AitoProject[];
  isDropTarget: boolean;
  onDeleteCard: (id: number) => void;
  onExpandCard: (id: number) => void;
  transitionConfig: { duration: number; easing: string } | null;
  shouldAnimateIn: (id: number) => boolean;
}

export function BoardColumn({
  column,
  projects,
  isDropTarget,
  onDeleteCard,
  onExpandCard,
  transitionConfig,
  shouldAnimateIn,
}: ColumnProps) {
  const { t } = useTranslation();
  const { setNodeRef } = useDroppable({ id: column.id });

  return (
    <div
      className={`w-72 sm:w-80 flex-shrink-0 flex flex-col rounded-xl bg-bambu-dark-secondary/40 border transition-[border-color,box-shadow] duration-150 ${
        isDropTarget ? `border-transparent ring-2 ${column.ring}` : 'border-bambu-dark-tertiary'
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-bambu-dark-tertiary/60">
        <span className={`w-2 h-2 rounded-full ${column.dot}`} />
        <h2 className="text-sm font-semibold text-white flex-1 truncate">{t(column.labelKey)}</h2>
        <span className="min-w-[1.5rem] px-1.5 py-0.5 text-center text-xs font-medium text-bambu-gray-light bg-bambu-dark-tertiary rounded-full tabular-nums">
          {projects.length}
        </span>
      </div>

      <SortableContext items={projects.map((p) => p.id)} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} className="flex-1 flex flex-col gap-2 p-2 min-h-[10rem] overflow-y-auto">
          {projects.map((project) => (
            <SortableCard
              key={project.id}
              project={project}
              onDelete={() => onDeleteCard(project.id)}
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
