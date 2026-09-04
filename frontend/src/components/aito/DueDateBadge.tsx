import { useTranslation } from 'react-i18next';
import { CalendarDays } from 'lucide-react';
import { dueDateCls, dueDateLevel } from '../../utils/aitoAging';
import { isFinished } from '../../utils/aitoBoard';
import { localDateKey, parseLocalDateKey } from '../../utils/date';
import type { ColumnId } from '../../utils/aitoBoard';

/** The promised day, short, coloured by how close it is. Nothing on a
 *  finished card: a delivered job is not late, whatever was promised. */
export function DueDateBadge({ dueDate, column }: { dueDate: string | null; column: ColumnId }) {
  const { t, i18n } = useTranslation();
  if (!dueDate || isFinished(column)) return null;
  const level = dueDateLevel(dueDate, localDateKey(new Date()));
  if (level === 'none') return null;
  const label = parseLocalDateKey(dueDate).toLocaleDateString(i18n.language, { day: 'numeric', month: 'short' });
  return (
    <span
      data-testid="aito-card-due"
      data-due-level={level}
      className={`inline-flex items-center gap-1 text-xs flex-shrink-0 tabular-nums ${dueDateCls(level)}`}
      aria-label={t('aito.dueBadge', { date: label })}
    >
      <CalendarDays className="w-3 h-3" aria-hidden="true" />
      {label}
    </span>
  );
}
