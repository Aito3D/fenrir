import { useRef, type ReactNode } from 'react';
import { useDismissableDialog } from '../../hooks/useDismissableDialog';

const SWIPE_CLOSE_PX = 60;

/** A bottom sheet for phone layouts: scrim, handle, swipe-down to close.
 *  Mount only while open; `children` gets the close request so a row can
 *  dismiss the sheet after acting. */
export function Sheet({
  label,
  testId,
  onClose,
  children,
}: {
  label: string;
  testId?: string;
  onClose: () => void;
  children: (close: () => void) => ReactNode;
}) {
  const { closing, requestClose, dialogRef } = useDismissableDialog(onClose, { animationMs: 200 });
  const pressY = useRef<number | null>(null);
  return (
    <div className="fixed inset-0 z-50">
      <div onClick={requestClose} className={`absolute inset-0 bg-black/45 ${closing ? 'animate-overlay-out' : 'animate-overlay-in'}`} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-testid={testId}
        tabIndex={-1}
        onPointerDown={(e) => {
          pressY.current = e.clientY;
        }}
        onPointerUp={(e) => {
          if (pressY.current !== null && e.clientY - pressY.current > SWIPE_CLOSE_PX) requestClose();
          pressY.current = null;
        }}
        onPointerCancel={() => {
          pressY.current = null;
        }}
        className={`absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-bambu-dark-tertiary bg-bambu-dark-secondary px-3 pt-2 pb-[calc(1rem+env(safe-area-inset-bottom))] focus:outline-none ${
          closing ? 'animate-sheet-out' : 'animate-sheet-in'
        }`}
      >
        <div aria-hidden="true" className="mx-auto mb-2.5 h-1 w-9 rounded-full bg-bambu-dark-tertiary" />
        {children(requestClose)}
      </div>
    </div>
  );
}
