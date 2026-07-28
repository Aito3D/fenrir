import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '../../api/client';
import { TaskRow } from './TaskRow';
import { Money } from '../calculator/shared';
import { focusRingCls } from '../formStyles';
import { emptyTaskDraft, projectTotal } from '../../utils/taskDraft';
import type { TaskDraft } from '../../utils/taskDraft';

export interface TaskEditorProps {
  value: TaskDraft[];
  onChange: (next: TaskDraft[]) => void;
  onRemove: (index: number) => void;
}

/** The task list for one Aito project: a heading, each task's `TaskRow`, "+
 *  Add task", and the project total. Purely presentational — it holds no
 *  persistence logic and never mutates `value` in place, only maps it into a
 *  new array. That split is what lets the create modal hold this array in
 *  local state and POST it with the project, while the detail panel wires
 *  each change to a PATCH; neither caller is visible from here. */
export function TaskEditor({ value, onChange, onRemove }: TaskEditorProps) {
  const { t } = useTranslation();
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.getSettings,
    staleTime: 60_000,
  });
  const currency = settings?.currency || 'USD';

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
            // A stable identity, not the row's position: keying by index
            // hands a deleted row's slot — and the mounted ImpressionFields
            // instance in it, `hasEdited` included — down to whichever row
            // slides up into it, silently recomputing and freeing that row's
            // frozen cost. `id` is stable and unique once a task is
            // persisted; `uid` (see TaskDraft) covers it before then. The
            // `persisted:`/`draft:` prefixes keep the two id spaces from ever
            // colliding (a draft's `id` is always null, never a real row id,
            // but nothing stops a future draft uid from formatting the same
            // as some row's numeric id without the prefix).
            // A stable identity, not the row's position: keying by index
            // hands a deleted row's slot — and the mounted ImpressionFields
            // instance in it, `hasEdited` included — down to whichever row
            // slides up into it, silently recomputing and freeing that row's
            // frozen cost. `id` is stable and unique once a task is
            // persisted; `uid` (see TaskDraft) covers it before then. The
            // `persisted:`/`draft:` prefixes keep the two id spaces from ever
            // colliding (a draft's `id` is always null, never a real row id,
            // but nothing stops a future draft uid from formatting the same
            // as some row's numeric id without the prefix).
            key={task.id !== null ? `persisted:${task.id}` : `draft:${task.uid}`}
            task={task}
            index={index}
            onChange={(next) => onChange(value.map((existing, i) => (i === index ? next : existing)))}
            onRemove={() => onRemove(index)}
          />
        ))}
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
