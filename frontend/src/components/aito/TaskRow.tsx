import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronRight, Pencil } from 'lucide-react';
import { api } from '../../api/client';
import { DeleteHoldButton } from './DeleteHoldButton';
import { ServiceBadges } from './ServiceBadges';
import { TaskStepFields } from './TaskStepFields';
import { TaskStepList } from './TaskStepList';
import { enabledServices, isTaskFinished, taskSteps } from './services';
import { Money } from '../calculator/shared';
import { focusRingCls } from '../formStyles';
import { taskTotal } from '../../utils/taskDraft';
import type { TaskDraft } from '../../utils/taskDraft';

export interface TaskRowProps {
  task: TaskDraft;
  index: number;
  onChange: (next: TaskDraft) => void;
  /** Absent, not merely disabled, when this row cannot be removed (see
   *  TaskEditor's `minRows`) — the control disappears entirely rather than
   *  sitting there inert. */
  onRemove?: () => void;
  expanded: boolean;
  onToggle: () => void;
  /** Whether the row's body is showing the edit form (`TaskStepFields`,
   *  Task 11) instead of the read-only `TaskStepList`. Owned by the caller,
   *  same split as `expanded`/`onToggle`. */
  editing: boolean;
  onToggleEdit: () => void;
  /** Called when focus leaves this row, so a debounced save can flush early
   *  rather than waiting out its timer. Optional: the create modal holds its
   *  tasks locally and has nothing to flush. */
  onRowBlur?: (task: TaskDraft) => void;
}

/** One task of a project: title/description, the four services (each
 *  optional — an empty service is a disabled one), the task total, and the
 *  hold-to-remove control. Purely presentational: every edit is reported
 *  upward through `onChange` with a new object, never applied in place, so
 *  the same row serves a local draft array (create modal) or a row wired to
 *  a PATCH (detail panel) without knowing which.
 *
 *  Collapsible, because a project with several tasks otherwise fills the
 *  surface. Collapsed, the row keeps its name, its service badges, its total
 *  and the remove control — enough to scan and prune a list without opening
 *  anything. `expanded` is owned by TaskEditor, which decides what a freshly
 *  added row starts as.
 *
 *  The body is unmounted rather than hidden when collapsed, which keeps the
 *  collapsed row cheap: a closed row runs none of ImpressionFields' three
 *  reference-data queries. */
export function TaskRow({
  task,
  index,
  onChange,
  onRemove,
  expanded,
  onToggle,
  editing,
  onToggleEdit,
  onRowBlur,
}: TaskRowProps) {
  const { t } = useTranslation();
  const reactId = useId();
  // Same query key ImpressionFields and the calculator page use for the
  // configured currency, so this rides their cache instead of adding a fetch.
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.getSettings,
    staleTime: 60_000,
  });
  const currency = settings?.currency || 'USD';

  const name = task.title.trim() || t('aito.taskFallbackName', { n: index + 1 });
  const finished = isTaskFinished(task);

  return (
    <div
      className={`animate-rise group rounded-lg border ${finished ? 'border-bambu-green/40 bg-bambu-green/5' : 'border-bambu-dark-tertiary'}`}
      onBlur={(e) => {
        // focusout bubbles in React, so one handler covers every input in the
        // row. relatedTarget is where focus went: inside the row means the
        // user is still editing it, so there is nothing to flush yet.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onRowBlur?.(task);
      }}
    >
      <div className="flex items-center gap-2 p-3">
        {/* The heading IS the toggle, so the whole row is one target rather
            than a chevron-sized one. Delete stays a sibling — a <button> may
            not contain another button. */}
        <h4 className="flex-1 min-w-0">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={`${reactId}-body`}
            className={`flex w-full items-center gap-2 text-left rounded-md ${focusRingCls}`}
          >
            <ChevronRight
              className={`w-4 h-4 flex-shrink-0 text-bambu-gray transition-transform duration-150 ${
                expanded ? 'rotate-90' : ''
              }`}
              aria-hidden="true"
            />
            <span className="text-sm font-medium text-white truncate min-w-0">{name}</span>
            {finished && (
              <Check className="w-3.5 h-3.5 flex-shrink-0 text-bambu-green" aria-label={t('aito.taskFinished')} />
            )}
            {!expanded && (
              <>
                <ServiceBadges
                  services={enabledServices(task)}
                  done={taskSteps(task).filter((s) => s.done).map((s) => s.service)}
                  className="flex-shrink-0"
                />
                <Money
                  currency={currency}
                  value={taskTotal(task)}
                  className="ml-auto flex-shrink-0 text-sm text-white"
                />
              </>
            )}
          </button>
        </h4>
        <button
          type="button"
          aria-label={t('aito.editTask')}
          aria-pressed={editing}
          title={t('aito.editTask')}
          onClick={onToggleEdit}
          className={`flex-shrink-0 p-1 -m-1 rounded-md transition-colors ${focusRingCls} ${
            editing ? 'text-bambu-green' : 'text-bambu-gray hover:text-white'
          }`}
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
        {onRemove && (
          <DeleteHoldButton onDelete={onRemove} label={t('aito.removeTask')} hint={t('aito.holdToDelete')} />
        )}
      </div>

      {expanded && (
        <div id={`${reactId}-body`} className="animate-slide-up px-3 pb-3 space-y-3">
          {editing ? (
            <TaskStepFields task={task} onChange={onChange} />
          ) : (
            <TaskStepList task={task} onChange={onChange} />
          )}
        </div>
      )}
    </div>
  );
}
