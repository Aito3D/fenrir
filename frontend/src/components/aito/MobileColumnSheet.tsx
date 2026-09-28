import { useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useDismissableDialog } from '../../hooks/useDismissableDialog';
import type { ColumnSummary } from '../../utils/aitoMobileBoard';
import { ColumnList } from './ColumnList';

const SWIPE_CLOSE_PX = 60;

/** Every board column in one list — count, oldest card, load — so any column
 *  is one tap away instead of up to five swipes. Mount only while open. */
export function MobileColumnSheet({
  columns,
  current,
  pending,
  heading,
  onPick,
  onClose,
}: {
  columns: ColumnSummary[];
  current: number;
  pending: boolean;
  heading: ReactNode;
  onPick: (index: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { closing, requestClose, dialogRef } = useDismissableDialog(onClose, { animationMs: 200 });
  const pressY = useRef<number | null>(null);

  return (
    <div className="fixed inset-0 z-50">
      <div
        data-testid="aito-mobile-sheet-scrim"
        onClick={requestClose}
        className={`absolute inset-0 bg-black/45 ${closing ? 'animate-overlay-out' : 'animate-overlay-in'}`}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('aito.mobile.columns')}
        tabIndex={-1}
        onPointerDown={(event) => {
          pressY.current = event.clientY;
        }}
        onPointerUp={(event) => {
          if (pressY.current !== null && event.clientY - pressY.current > SWIPE_CLOSE_PX) requestClose();
          pressY.current = null;
        }}
        onPointerCancel={() => {
          pressY.current = null;
        }}
        // touch-none: the sheet has nothing to scroll, so it owns vertical
        // drags — otherwise the browser starts a pan, fires pointercancel,
        // and the swipe-down never sees its pointerup on a touch screen.
        className={`touch-none absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-bambu-dark-tertiary bg-bambu-dark-secondary px-3 pt-2 pb-[calc(1.5rem+env(safe-area-inset-bottom))] focus:outline-none ${
          closing ? 'animate-sheet-out' : 'animate-sheet-in'
        }`}
      >
        <div aria-hidden="true" className="mx-auto mb-2.5 h-1 w-9 rounded-full bg-bambu-dark-tertiary" />
        <div className="flex flex-wrap items-center gap-2 px-1.5 pb-2.5">{heading}</div>
        <ColumnList
          columns={columns}
          from={current}
          to={current}
          pending={pending}
          onPick={(index) => {
            onPick(index);
            requestClose();
          }}
        />
      </div>
    </div>
  );
}
