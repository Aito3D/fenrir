import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '../../api/client';
import { TaskRow } from './TaskRow';
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
 *  Doubles as the key for a row's expanded/collapsed state and every
 *  uncontrolled input inside the row — one more reason `key` and toggle state
 *  must use the exact same string, which is why it is a named function
 *  rather than an expression inlined into the `key` prop: those two must
 *  agree, or toggling one row would open another. */
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
}

/** The task list for one Aito project: a heading, each task's `TaskRow`, "+
 *  Add task", and the project total. Purely presentational — it holds no
 *  persistence logic and never mutates `value` in place, only maps it into a
 *  new array. That split is what lets the create modal hold this array in
 *  local state and POST it with the project, while the detail panel wires
 *  each change to a PATCH; neither caller is visible from here. */
export function TaskEditor({ value, onChange, onRemove, minRows = 0 }: TaskEditorProps) {
  const { t } = useTranslation();
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.getSettings,
    staleTime: 60_000,
  });
  const currency = settings?.currency || 'USD';

  // Which rows are open. Everything starts collapsed — a project with several
  // tasks is exactly the case this exists for, so the space win has to land on
  // open rather than after the user collapses each row by hand.
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

  // Which rows are open for editing (showing the form instead of the
  // read-only step list), keyed exactly like `expandedKeys` — the two must
  // agree, or toggling one row's form would open another's. `TaskStepFields`
  // (Task 11) is what actually renders differently for an editing row; until
  // then this only drives the Edit button's pressed state.
  const [editingKeys, setEditingKeys] = useState<Set<string>>(new Set());
  const toggleEdit = (key: string) =>
    setEditingKeys((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  // ...except a row the user just added, which opens so they can fill it in.
  // Spotting it takes a flag plus a diff, because the key of the new row is
  // not knowable at the moment "+ Add task" is pressed: the create modal
  // appends a draft (key `draft:<uid>`), while the detail panel routes the
  // same click to a POST and only learns the row's real key (`persisted:<id>`)
  // when the refetch lands. Diffing against the previous keys covers both, and
  // gating on the flag keeps the initial fetch — which also grows the array
  // from nothing — from opening every task on the project.
  //
  // It opens in EDIT mode too, not just expanded: a freshly added task has no
  // steps yet, so read mode would show nothing but "No steps yet" — the user
  // still needs the form to give it its first cost.
  const addRequestedRef = useRef(false);
  const previousKeysRef = useRef<string[]>([]);

  useEffect(() => {
    const keys = value.map(rowKey);
    const previous = previousKeysRef.current;
    previousKeysRef.current = keys;
    if (!addRequestedRef.current) return;
    const added = keys.filter((key) => !previous.includes(key));
    if (added.length === 0) return; // the add is still in flight
    addRequestedRef.current = false;
    setExpandedKeys((current) => new Set([...current, ...added]));
    setEditingKeys((current) => new Set([...current, ...added]));
  }, [value]);

  const toggle = (key: string) =>
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

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
        {value.map((task, index) => (
          <TaskRow
            key={rowKey(task)}
            task={task}
            index={index}
            onChange={(next) => onChange(value.map((existing, i) => (i === index ? next : existing)))}
            onRemove={value.length > minRows ? () => onRemove(index) : undefined}
            expanded={expandedKeys.has(rowKey(task))}
            onToggle={() => toggle(rowKey(task))}
            editing={editingKeys.has(rowKey(task))}
            onToggleEdit={() => toggleEdit(rowKey(task))}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={() => {
          addRequestedRef.current = true;
          onChange([...value, emptyTaskDraft()]);
        }}
        className={`inline-flex items-center gap-1 text-sm text-bambu-green hover:text-bambu-green/80 transition-colors rounded-md ${focusRingCls}`}
      >
        <Plus className="w-4 h-4" />
        {t('aito.addTask')}
      </button>
    </div>
  );
}
