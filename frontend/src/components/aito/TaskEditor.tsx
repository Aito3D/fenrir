import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '../../api/client';
import { TaskRow } from './TaskRow';
import { taskSteps } from './services';
import { Money } from '../calculator/shared';
import { focusRingCls } from '../formStyles';
import { emptyTaskDraft, projectTotal } from '../../utils/taskDraft';
import type { TaskDraft } from '../../utils/taskDraft';

/** A stable identity for a row, not its position.
 *
 *  Keying by index hands a deleted row's slot — and everything mounted in
 *  it, the ImpressionFields instance included — down to whichever row slides
 *  up into it: same component identities, same DOM nodes, now showing a
 *  different row's data without ever remounting. `id` is stable and unique
 *  once a task is persisted; `uid` (see TaskDraft) covers it before then. The
 *  `persisted:`/`draft:` prefixes keep the two id spaces from ever colliding
 *  (a draft's `id` is always null, never a real row id, but nothing stops a
 *  future draft uid from formatting the same as some row's numeric id
 *  without the prefix).
 *
 *  Doubles as the key for a row's editing state and every uncontrolled input
 *  inside the row — one more reason `key` and toggle state must use the exact
 *  same string, which is why it is a named function rather than an
 *  expression inlined into the `key` prop: those two must agree, or toggling
 *  one row's form would open another's. */
function rowKey(task: TaskDraft): string {
  return task.id !== null ? `persisted:${task.id}` : `draft:${task.uid}`;
}

export interface TaskEditorProps {
  value: TaskDraft[];
  onChange: (next: TaskDraft[]) => void;
  onRemove: (index: number) => void;
  /** Rows that cannot be removed. The create modal passes 1: a project must
   *  carry at least one task, and letting the user delete their way to zero
   *  and then be told "no" is worse than not offering it. Defaults to 0 so the
   *  detail panel is unaffected. */
  minRows?: number;
  /** Called when focus leaves a row, so a debounced save can flush early
   *  rather than waiting out its timer. Optional: the create modal holds its
   *  tasks locally and has nothing to flush. */
  onRowBlur?: (task: TaskDraft) => void;
  /** Passed straight to `TaskStepList` — see its own prop doc. Required, not
   *  defaulted: a default is exactly how a caller with no quote (the create
   *  modal) would silently inherit the wrong answer. */
  canTick: boolean;
  /** Uids of rows whose create POST is still in flight — `useProjectTasks`'
   *  `pendingTaskUids`. Such a row renders inert (see `TaskRow`'s `pending`
   *  prop): its inputs disabled, its delete control absent — otherwise
   *  anything typed into it is silently lost the moment the POST resolves
   *  and swaps the placeholder for the server's echo of the request that was
   *  in flight (see `useProjectTasks`' `addTaskMutation.onSuccess`).
   *
   *  Optional, and deliberately never defaulted to a bare `id === null`
   *  check: the create modal (`NewProjectModal`) reuses this component and
   *  EVERY one of its rows has `id === null` while none of them are actually
   *  pending a network call, so it must stay fully editable. It simply
   *  passes nothing. */
  pendingUids?: Set<string>;
}

/** The task list for one Aito project: a heading, each task's `TaskRow`, "+
 *  Add task", and the project total. Purely presentational — it holds no
 *  persistence logic and never mutates `value` in place, only maps it into a
 *  new array. That split is what lets the create modal hold this array in
 *  local state and POST it with the project, while the detail panel wires
 *  each change to a PATCH; neither caller is visible from here. */
export function TaskEditor({
  value,
  onChange,
  onRemove,
  canTick,
  minRows = 0,
  onRowBlur,
  pendingUids,
}: TaskEditorProps) {
  const { t } = useTranslation();
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.getSettings,
    staleTime: 60_000,
  });
  const currency = settings?.currency || 'USD';

  // Which rows are open for editing (showing the form instead of the
  // read-only step list), keyed by `rowKey` — same key `isEditing` below
  // checks, or toggling one row's form would open another's.
  const [editingKeys, setEditingKeys] = useState<Set<string>>(new Set());
  const toggleEdit = (key: string) =>
    setEditingKeys((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  // A row with no steps IS the form — read mode would show nothing but "No
  // steps yet", so there is nothing to disclose. Deriving this replaces the
  // effect that used to diff row keys to open a newly added row in edit mode,
  // and fixes the create modal for free: its first task previously started
  // both collapsed and not editing, costing two clicks before the user could
  // type a price.
  const isEditing = (task: TaskDraft) => editingKeys.has(rowKey(task)) || taskSteps(task).length === 0;

  // A stepless row is auto-edited by `isEditing` above, not by an explicit
  // `editingKeys` entry — so the instant its FIRST keystroke prices a
  // service, `taskSteps` stops being empty and the OR's other half stops
  // being true. Without latching the key in here, that one keystroke would
  // flip the row to read mode mid-edit and drop focus out of the input the
  // user is still typing into. This is the only place that can catch the
  // 0-steps-to-1-step transition without reintroducing the diff-the-previous-
  // render effect Task 17 removed: it runs inside the same `onChange` the
  // edit itself flows through, so it sees the row's step count both before
  // and after in one place, no extra render needed.
  const graduateToEditing = (before: TaskDraft, after: TaskDraft) => {
    if (taskSteps(before).length === 0 && taskSteps(after).length > 0) {
      setEditingKeys((current) => new Set([...current, rowKey(after)]));
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-white">{t('aito.tasks')}</h3>
        <div className="flex items-baseline gap-2">
          <span className="text-sm text-bambu-gray">{t('aito.projectTotal')}</span>
          <Money currency={currency} value={projectTotal(value)} className="text-bambu-green font-medium" />
        </div>
      </div>

      <div className="space-y-3">
        {value.map((task, index) => {
          const pending = pendingUids?.has(task.uid) ?? false;
          return (
            <TaskRow
              key={rowKey(task)}
              task={task}
              index={index}
              onChange={(next) => {
                graduateToEditing(task, next);
                onChange(value.map((existing, i) => (i === index ? next : existing)));
              }}
              // Absent (not merely disabled) while pending too, same rule as
              // `minRows` below it: the row's create hasn't landed, so there
              // is no id yet to send a DELETE for — see TaskRow's own prop doc.
              onRemove={value.length > minRows && !pending ? () => onRemove(index) : undefined}
              editing={isEditing(task)}
              onToggleEdit={() => toggleEdit(rowKey(task))}
              onRowBlur={onRowBlur}
              canTick={canTick}
              pending={pending}
            />
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => onChange([...value, emptyTaskDraft()])}
        className={`inline-flex items-center gap-1 text-sm text-bambu-green hover:text-bambu-green/80 transition-colors rounded-md ${focusRingCls}`}
      >
        <Plus className="w-4 h-4" />
        {t('aito.addTask')}
      </button>
    </div>
  );
}
