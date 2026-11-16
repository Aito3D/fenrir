import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useDismissableDialog } from '../../hooks/useDismissableDialog';
import { Button } from '../Button';

/** Shared shell of the tree page's modals: overlay, Escape/click-outside close, a Close button. */
export function Dialog({ title, onClose, children, footer }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { t } = useTranslation();
  // 150ms = .animate-modal-out; Escape, the backdrop and Close play it, a modal closing itself after a save does not
  const { dialogRef, closing, requestClose } = useDismissableDialog(onClose, { animationMs: 150 });
  return (
    <div
      className={`fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 ${closing ? 'animate-overlay-out' : 'animate-overlay-in'}`}
      onClick={requestClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary focus:outline-none ${closing ? 'animate-modal-out' : 'animate-modal-in'}`}
        onClick={(e) => e.stopPropagation()}
        // a cancelled dialog's footer (e.g. SYNC Confirm) must not fire during the close animation: inert covers keyboard, the style covers pointers
        inert={closing}
        style={closing ? { pointerEvents: 'none' } : undefined}
      >
        <h3 className="border-b border-bambu-dark-tertiary px-5 py-3 text-lg font-semibold text-white">{title}</h3>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">{children}</div>
        <div className="flex justify-end gap-2 border-t border-bambu-dark-tertiary px-5 py-3">
          <Button variant="secondary" onClick={requestClose}>
            {t('common.close')}
          </Button>
          {footer}
        </div>
      </div>
    </div>
  );
}
