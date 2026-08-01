import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Check, Pencil } from 'lucide-react';
import { api } from '../../api/client';
import { DeleteHoldButton } from './DeleteHoldButton';
import { ProjectProgress } from './ProjectProgress';
import { TaskStepFields } from './TaskStepFields';
import { TaskStepList } from './TaskStepList';
import { isTaskFinished, taskSteps } from './services';
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
  /** Whether the row's body is showing the edit form (`TaskStepFields`,
   *  Task 11) instead of the read-only `TaskStepList`. Owned by the caller. */
  editing: boolean;
  onToggleEdit: () => void;
  /** Called when focus leaves this row, so a debounced save can flush early
   *  rather than waiting out its timer. Optional: the create modal holds its
   *  tasks locally and has nothing to flush. */
  onRowBlur?: (task: TaskDraft) => void;
  /** Passed straight to `TaskStepList` — see its own prop doc. Required, not
   *  defaulted: a default is exactly how a caller with no quote (the create
   *  modal) would silently inherit the wrong answer. */
  canTick: boolean;
  /** True while this row's create POST is still in flight — see
   *  `TaskEditor`'s `pendingUids`. Disables the edit form (`TaskStepFields`)
   *  so nothing typed here can be silently overwritten once the POST
   *  resolves, and hides the delete control the same way `onRemove` being
   *  absent already does for a row that cannot be removed. Defaults to
   *  false, so every existing caller (and every persisted row) is
   *  unaffected. */
  pending?: boolean;
}

/** One task of a project: title/description, the four services (each
 *  optional — an empty service is a disabled one), the task total, and the
 *  hold-to-remove control. Purely presentational: every edit is reported
 *  upward through `onChange` with a new object, never applied in place, so
 *  the same row serves a local draft array (create modal) or a row wired to
 *  a PATCH (detail panel) without knowing which.
 *
 *  Always open. The row was collapsible when it held a form, and the cost of
 *  that was a click between the user and the one control they reach for most —
 *  Done. Now that read mode is a short step list, the row is simply a card.
 *
 *  `TaskStepFields` (edit mode) still mounts only behind the pencil, so an
 *  open row in read mode still runs none of ImpressionFields' three
 *  reference-data queries. */
export function TaskRow({
  task,
  index,
  onChange,
  onRemove,
  editing,
  onToggleEdit,
  onRowBlur,
  canTick,
  pending = false,
}: TaskRowProps) {
  const { t } = useTranslation();
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
  const steps = taskSteps(task);

  return (
    <div
      // Finishing the last step turns the whole row green. That is the largest
      // state change in the panel and it used to arrive on a single frame, so
      // it gets the same 300ms the pills and the progress bar use — one tick,
      // one settling motion, wherever it shows up. The transition composes with
      // the mount `animate-rise` above: an animation and a transition on the
      // same element drive different properties here.
      //
      // `card-shadow` unconditionally: this is the ONLY thing in the panel
      // that casts one (see PanelCard's doc) — it is what ranks the task
      // column as the front plane against the four bordered-only reference
      // cards in the left column. The background itself stays one class per
      // state rather than layering `bg-bambu-dark-secondary` underneath the
      // finished tint: two `bg-*` utilities on one element race each other in
      // Tailwind's generated stylesheet, so unfinished gets the plain surface
      // tone and finished keeps its own green wash instead.
      className={`animate-rise group rounded-lg border card-shadow transition-colors duration-300 ease-[var(--ease-signature)] motion-reduce:transition-none ${
        finished ? 'border-bambu-green/40 bg-bambu-green/5' : 'border-bambu-dark-tertiary bg-bambu-dark-secondary'
      }`}
      onBlur={(e) => {
        // focusout bubbles in React, so one handler covers every input in the
        // row. relatedTarget is where focus went: inside the row means the
        // user is still editing it, so there is nothing to flush yet.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onRowBlur?.(task);
      }}
    >
      <div className="flex items-center gap-2 p-3">
        <h4 className="flex-1 min-w-0 flex items-center gap-2">
          <span className="text-sm font-medium text-white truncate min-w-0">{name}</span>
          {finished && (
            <Check className="w-3.5 h-3.5 flex-shrink-0 text-bambu-green" aria-label={t('aito.taskFinished')} />
          )}
          {steps.length > 0 && (
            <span className="text-xs text-bambu-gray flex-shrink-0 tabular-nums">
              {t('aito.stepsCount', { done: steps.filter((s) => s.done).length, total: steps.length })}
            </span>
          )}
          <Money
            currency={currency}
            value={taskTotal(task)}
            className="ml-auto flex-shrink-0 text-sm text-white"
          />
        </h4>
        {/* Hidden on a stepless row: that row is already showing the form, so
            there is no other mode to switch to. */}
        {steps.length > 0 && (
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
        )}
        {onRemove && (
          <DeleteHoldButton onDelete={onRemove} label={t('aito.removeTask')} hint={t('aito.holdToDelete')} />
        )}
      </div>

      {/* The task's own progress, under its header. `ProjectProgress` renders
          nothing at zero steps, so an unpriced row shows no empty track. */}
      <div className="px-3 pb-2">
        <ProjectProgress
          done={steps.filter((s) => s.done).length}
          total={steps.length}
          testId={`task-progress-${index}`}
        />
      </div>

      <div className="px-3 pb-3 space-y-3">
        {editing ? (
          <TaskStepFields task={task} onChange={onChange} disabled={pending} />
        ) : (
          <TaskStepList task={task} onChange={onChange} canTick={canTick} />
        )}
      </div>
    </div>
  );
}
