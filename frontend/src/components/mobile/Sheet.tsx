import { useRef, useState, type ReactNode } from 'react';
import { useDismissableDialog } from '../../hooks/useDismissableDialog';

const SWIPE_CLOSE_PX = 60;
// A flick closes too: px/ms, past a small distance so a tap never counts.
const FLICK_SPEED = 0.11;
const FLICK_MIN_PX = 12;

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
  const press = useRef<{ y: number; t: number } | null>(null);
  const [dy, setDy] = useState(0);
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
          press.current = { y: e.clientY, t: e.timeStamp };
        }}
        onPointerMove={(e) => {
          if (!press.current || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
          const d = e.clientY - press.current.y;
          setDy(d > 0 ? d : d * 0.2); // follows down, resists up
        }}
        onPointerUp={(e) => {
          if (press.current) {
            const d = e.clientY - press.current.y;
            const speed = d / Math.max(1, e.timeStamp - press.current.t);
            if (d > SWIPE_CLOSE_PX || (d > FLICK_MIN_PX && speed > FLICK_SPEED)) requestClose();
          }
          press.current = null;
          setDy(0);
        }}
        onPointerCancel={() => {
          press.current = null;
          setDy(0);
        }}
        style={dy ? { transform: `translateY(${dy}px)` } : undefined}
        className={`absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-bambu-dark-tertiary bg-bambu-dark-secondary px-3 pt-2 pb-[calc(1rem+env(safe-area-inset-bottom))] focus:outline-none ${dy ? '' : 'transition-transform duration-200 ease-[var(--ease-signature)]'} ${
          closing ? 'animate-sheet-out' : 'animate-sheet-in'
        }`}
      >
        <div aria-hidden="true" className="mx-auto mb-2.5 h-1 w-9 rounded-full bg-bambu-dark-tertiary" />
        {children(requestClose)}
      </div>
    </div>
  );
}
