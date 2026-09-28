import { useTranslation } from 'react-i18next';
import type { ColumnSummary } from '../../utils/aitoMobileBoard';

/** The six-segment load strip: one segment per column, sized by its count,
 *  the visible window lit. The phone lights one column, the tablet several.
 *
 *  Each segment is a real button with a taller invisible hit area (the
 *  ::after) so a 3 px line is still tappable. */
export function ColumnStrip({
  columns,
  from,
  to,
  onJump,
  className = '',
}: {
  columns: ColumnSummary[];
  from: number;
  to: number;
  onJump: (index: number) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className={`flex gap-0.5 h-[3px] ${className}`}>
      {columns.map((summary, index) => {
        const lit = index >= from && index <= to;
        return (
          <button
            key={summary.column.id}
            type="button"
            data-testid={`aito-mobile-segment-${summary.column.id}`}
            onClick={() => onJump(index)}
            aria-current={lit ? 'true' : undefined}
            aria-label={t('aito.mobile.segment', { column: t(summary.column.labelKey), count: summary.count })}
            style={{ flexGrow: Math.max(summary.count, 0.4) }}
            className={`relative basis-0 min-w-3 h-full ${summary.column.dot} transition-[opacity,flex-grow] duration-200 motion-reduce:transition-none after:absolute after:inset-x-0 after:-top-3 after:-bottom-1 after:content-[''] ${
              lit ? 'opacity-100' : 'opacity-25'
            }`}
          />
        );
      })}
    </div>
  );
}
