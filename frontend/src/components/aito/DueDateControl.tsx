import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays, X } from 'lucide-react';
import { useDueDateMutation } from '../../hooks/useDueDateMutation';
import { headerPillRadiusCls } from './panelTypography';
import { focusRingCls } from '../formStyles';
import type { AitoProject } from '../../api/client';

/** The promised day, editable in the panel's status row. A native date input
 *  (the browser's picker beats any custom one on a phone) wearing the header
 *  pill's radius so it sits beside the flag. */
export function DueDateControl({ project }: { project: AitoProject }) {
  const { t } = useTranslation();
  const id = useId();
  const mutation = useDueDateMutation(project);
  const current = project.due_date ?? null;

  /** A native date input fires `change` for EVERY intermediate value a typed
   *  year passes through: typing "2026" over an otherwise complete date emits
   *  0002-09-12, 0020-09-12, 0202-09-12 and only then 2026-09-12. Committing
   *  those would be four PATCHes, four `project.due.set` story events and
   *  three renders of a card promised in antiquity, i.e. overdue.
   *
   *  A year below 2000 is therefore a keystroke, not a promise, and is
   *  dropped. `min` below tells the browser's own picker the same, so the two
   *  agree about what is selectable. Clearing (null) always commits. */
  const commit = (next: string | null) => {
    if (next !== null && Number(next.slice(0, 4)) < 2000) return;
    if (next === current) return;
    mutation.mutate(next);
  };

  return (
    <span data-testid="due-date-control" className="inline-flex items-center gap-1">
      <label htmlFor={id} className="sr-only">
        {t('aito.dueDate')}
      </label>
      <span
        className={`inline-flex items-center gap-1.5 border border-bambu-dark-tertiary bg-bambu-dark px-2 py-0.5 text-xs text-bambu-gray-light ${headerPillRadiusCls}`}
      >
        <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
        <input
          id={id}
          type="date"
          min="2000-01-01"
          value={current ?? ''}
          onChange={(e) => commit(e.target.value || null)}
          className={`bg-transparent text-xs text-white tabular-nums ${focusRingCls}`}
        />
      </span>
      {current !== null && (
        <button
          type="button"
          aria-label={t('aito.dueDateClear')}
          onClick={() => commit(null)}
          className={`rounded-full p-0.5 text-bambu-gray hover:text-white ${focusRingCls}`}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
