import { useTranslation } from 'react-i18next';
import type { ColumnSummary } from '../../utils/aitoMobileBoard';
import { ColumnCountPill, OldestCardChip } from './MobileBoardHeader';

/** Every board column as one row — count, oldest card, load — with the
 *  visible window (`from`..`to`) marked current. Shared by the phone's column
 *  sheet (a window of one) and the tablet's column popover. */
export function ColumnList({
  columns,
  from,
  to,
  pending,
  onPick,
}: {
  columns: ColumnSummary[];
  from: number;
  to: number;
  pending: boolean;
  onPick: (index: number) => void;
}) {
  const { t } = useTranslation();
  const max = Math.max(1, ...columns.map((c) => c.count));
  return (
    <ul>
      {columns.map((summary, index) => {
        const current = index >= from && index <= to;
        return (
          <li key={summary.column.id}>
            <button
              type="button"
              data-column={summary.column.id}
              aria-current={current ? 'true' : undefined}
              onClick={() => onPick(index)}
              className={`w-full flex items-center gap-2.5 px-2.5 py-3 rounded-xl text-left text-[15px] ${
                current ? 'bg-bambu-dark-tertiary/60 text-white' : 'text-bambu-gray-light active:bg-bambu-dark-tertiary/40'
              }`}
            >
              <span aria-hidden="true" className={`w-2 h-2 flex-none rounded-full ${summary.column.dot}`} />
              <span className="flex-1 min-w-0 truncate">{t(summary.column.labelKey)}</span>
              {!pending && <OldestCardChip summary={summary} />}
              <ColumnCountPill count={summary.count} pending={pending} />
              <span aria-hidden="true" className="flex-none h-1 w-14 overflow-hidden rounded-full bg-bambu-dark-tertiary">
                <span
                  className={`block h-full ${summary.column.dot}`}
                  style={{ width: `${Math.round((100 * summary.count) / max)}%` }}
                />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
