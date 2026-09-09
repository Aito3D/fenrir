import { useTranslation } from 'react-i18next';
import { CalendarDays } from 'lucide-react';
import { dueDateCls, dueDateDays, dueDateLevel, dueRelativeLabel } from '../../utils/aitoAging';
import { isFinished } from '../../utils/aitoBoard';
import { localDateKey, parseLocalDateKey } from '../../utils/date';
import type { ColumnId } from '../../utils/aitoBoard';

/** How far off the promise is — "tomorrow", "in 3 days", "in 2 weeks" —
 *  coloured by how close it is, with the day itself in the tooltip. A
 *  distance is what the board is read for; the date made the reader do the
 *  subtraction on every card. Nothing on a finished card: a delivered job
 *  is not late, whatever was promised. */
export function DueDateBadge({ dueDate, column }: { dueDate: string | null; column: ColumnId }) {
  const { t, i18n } = useTranslation();
  if (!dueDate || isFinished(column)) return null;
  const today = localDateKey(new Date());
  const level = dueDateLevel(dueDate, today);
  const days = dueDateDays(dueDate, today);
  if (level === 'none' || days === null) return null;
  const date = parseLocalDateKey(dueDate).toLocaleDateString(i18n.language, { day: 'numeric', month: 'short' });
  return (
    <span
      data-testid="aito-card-due"
      data-due-level={level}
      title={t('aito.dueBadge', { date })}
      className={`inline-flex items-center gap-1 text-xs flex-shrink-0 tabular-nums ${dueDateCls(level)}`}
      aria-label={t('aito.dueBadge', { date })}
    >
      <CalendarDays className="w-3 h-3" aria-hidden="true" />
      {dueRelativeLabel(days, i18n.language, t)}
    </span>
  );
}
