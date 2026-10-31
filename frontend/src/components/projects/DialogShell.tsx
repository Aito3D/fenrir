import type { FormEvent, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { DIALOG_CARD_CLS, DIALOG_CLOSING_CARD_CLS, DIALOG_CLOSING_OVERLAY_CLS, OVERLAY_CLS } from './dialogStyles';

interface Props {
  /** The card; the caller wires it to `useIsolatedEscape` (Escape stays the caller's). */
  dialogRef: RefObject<HTMLFormElement | null>;
  /** The dialog's accessible name. */
  title: string;
  /** Backdrop click. Clicks inside the card never reach the backdrop. */
  onClose: () => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  /** The exit is playing (`useDialogExit`): card and backdrop leave the way they came, and the
   *  dialog takes no more input. */
  closing?: boolean;
  children: ReactNode;
}

/** A projects form dialog portalled to `document.body`: dimmed backdrop that
 *  closes on click, and a modal `<form role="dialog">` card. */
export function DialogShell({ dialogRef, title, onClose, onSubmit, closing = false, children }: Props) {
  return createPortal(
    <div className={closing ? `${OVERLAY_CLS} ${DIALOG_CLOSING_OVERLAY_CLS}` : OVERLAY_CLS} onClick={closing ? undefined : onClose}>
      <form
        inert={closing || undefined}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onSubmit={onSubmit}
        className={closing ? `${DIALOG_CARD_CLS} ${DIALOG_CLOSING_CARD_CLS}` : DIALOG_CARD_CLS}
      >
        {children}
      </form>
    </div>,
    document.body,
  );
}
