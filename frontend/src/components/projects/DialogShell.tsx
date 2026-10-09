import type { FormEvent, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { DIALOG_CARD_CLS, OVERLAY_CLS } from './dialogStyles';

interface Props {
  /** The card; the caller wires it to `useIsolatedEscape` (Escape stays the caller's). */
  dialogRef: RefObject<HTMLFormElement | null>;
  /** The dialog's accessible name. */
  title: string;
  /** Backdrop click. Clicks inside the card never reach the backdrop. */
  onClose: () => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}

/** A projects form dialog portalled to `document.body`: dimmed backdrop that
 *  closes on click, and a modal `<form role="dialog">` card. */
export function DialogShell({ dialogRef, title, onClose, onSubmit, children }: Props) {
  return createPortal(
    <div className={OVERLAY_CLS} onClick={onClose}>
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onSubmit={onSubmit}
        className={DIALOG_CARD_CLS}
      >
        {children}
      </form>
    </div>,
    document.body,
  );
}
