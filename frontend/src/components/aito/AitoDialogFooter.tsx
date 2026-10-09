import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '../Button';

type AitoDialogFooterProps = {
  /** The request's error line (empty while there is none). */
  error?: string | null;
  /** Also put the error in the line's `title`, for a message the truncation clips. */
  errorTitle?: boolean;
  /** Replaces the error line with the dialog's own left-hand status. */
  status?: ReactNode;
  /** The dialog's mutation in flight: Cancel is disabled and the confirm spins. */
  pending: boolean;
  /** Renders the secondary Cancel button (disabled while `pending`). */
  onCancel?: () => void;
  /** Takes the Cancel button's slot instead (a Back step, Stop watching, or nothing). */
  secondary?: ReactNode;
  confirmLabel: string;
  confirmDisabled: boolean;
  onConfirm: () => void;
  /** Spin while `pending` (default); off for a confirm that only steps forward. */
  confirmSpinner?: boolean;
};

/** The footer the panel's stacked Aito dialogs share (merge, transfer client,
 *  split/move tasks, watch): the red error line on the left, then the
 *  secondary button and the primary confirm with its in-flight spinner. */
export function AitoDialogFooter({
  error = null,
  errorTitle = false,
  status,
  pending,
  onCancel,
  secondary,
  confirmLabel,
  confirmDisabled,
  onConfirm,
  confirmSpinner = true,
}: AitoDialogFooterProps) {
  const { t } = useTranslation();
  const cancel = onCancel ? (
    <Button variant="secondary" size="sm" onClick={onCancel} disabled={pending}>
      {t('common.cancel')}
    </Button>
  ) : null;
  return (
    <footer className="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3">
      {status !== undefined ? (
        status
      ) : (
        <p
          role="alert"
          className="min-w-0 truncate text-xs text-red-400"
          title={errorTitle ? (error ?? undefined) : undefined}
        >
          {error}
        </p>
      )}
      <div className="flex flex-none items-center gap-2">
        {secondary !== undefined ? secondary : cancel}
        <Button variant="primary" size="sm" disabled={confirmDisabled} onClick={onConfirm}>
          {confirmSpinner && pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          {confirmLabel}
        </Button>
      </div>
    </footer>
  );
}
