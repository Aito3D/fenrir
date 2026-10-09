import type { ReactNode, RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { X, type LucideIcon } from 'lucide-react';
import { Card, CardContent } from '../Card';
import { focusRingCls } from '../formStyles';

/** The standard header: a 36px icon tile, the `label` as the title, a
 *  one-line subtitle, and the close X. */
type StandardHeader = {
  icon: LucideIcon;
  subtitle: ReactNode;
  /** Clip the subtitle to one line (a free-text subtitle such as a card
   *  description); the fixed i18n subtitles wrap. */
  truncateSubtitle?: boolean;
  header?: never;
};

/** A dialog that draws its own header inside the shell's frame. */
type CustomHeader = {
  header: ReactNode;
  icon?: never;
  subtitle?: never;
  truncateSubtitle?: never;
};

type AitoDialogShellProps = (StandardHeader | CustomHeader) & {
  /** The dialog's accessible name; also the standard header's title. */
  label: string;
  testId: string;
  /** From the dialog's `useDismissableDialog`. */
  closing: boolean;
  requestClose: () => void;
  dialogRef: RefObject<HTMLDivElement | null>;
  /** A mutation in flight: Escape is ignored until it settles. */
  busy?: boolean;
  /** Sets `aria-busy="true"` on the dialog (initial data still loading). */
  ariaBusy?: boolean;
  /** The Card's max width, e.g. `max-w-[560px]`. */
  maxWidthCls: string;
  /** Cap the dialog at 88vh and let its content shrink (a scrolling list). */
  capHeight?: boolean;
  /** Everything under the header: body and footer. */
  children: ReactNode;
};

/** The frame the panel's stacked Aito dialogs share (merge, transfer client,
 *  split/move tasks, watch, client history): the z-[110] backdrop, the
 *  Escape trap, the Card with its enter/exit animation, and (unless the
 *  dialog brings its own) the icon/title/subtitle/close header.
 *
 *  z-[110], not z-50: the panel's own backdrop is z-50, so a lower overlay
 *  renders behind the panel that opened the dialog.
 *
 *  The panel's own window-level Escape listener (useDismissableDialog, in
 *  ProjectDetailPanel) is still mounted while a dialog is open, so one Escape
 *  would otherwise fire both: the dialog closes AND the panel closes back to
 *  the board. Stopping propagation here — in a React onKeyDown, before the
 *  event reaches window — keeps it from reaching that listener. Focus is
 *  inside the dialog on mount (`dialogRef.focus()`), so this fires; a
 *  combobox inside stops its own Escape first while its list is open. */
export function AitoDialogShell(props: AitoDialogShellProps) {
  const { t } = useTranslation();
  const { label, testId, closing, requestClose, dialogRef, busy = false, ariaBusy = false } = props;
  const { maxWidthCls, capHeight = false, children } = props;

  let header: ReactNode = props.header;
  if (props.icon !== undefined) {
    const Icon = props.icon;
    header = (
      <header className="grid grid-cols-[36px_1fr_auto] items-center gap-x-3 px-6 pt-5 pb-4">
        <span
          aria-hidden="true"
          className="grid h-9 w-9 place-items-center rounded-[9px] bg-bambu-dark-tertiary text-bambu-gray-light"
        >
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0">
          <h2 className="text-[1.05rem] font-semibold leading-tight text-white truncate">{label}</h2>
          <p className={`mt-0.5 text-xs text-bambu-gray leading-snug${props.truncateSubtitle ? ' truncate' : ''}`}>
            {props.subtitle}
          </p>
        </div>
        <button
          type="button"
          onClick={requestClose}
          aria-label={t('common.close')}
          className={`grid h-8 w-8 place-items-center rounded-md text-bambu-gray transition-colors hover:bg-bambu-dark-tertiary hover:text-white ${focusRingCls}`}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>
    );
  }

  return (
    <div
      className={`fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-[110] ${
        closing ? 'animate-overlay-out pointer-events-none' : 'animate-overlay-in'
      }`}
      onClick={requestClose}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        if (!closing && !busy) requestClose();
      }}
    >
      <Card
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-busy={ariaBusy ? 'true' : undefined}
        data-testid={testId}
        tabIndex={-1}
        className={`w-full ${maxWidthCls}${capHeight ? ' max-h-[88vh]' : ''} flex flex-col focus:outline-none ${
          closing ? 'animate-modal-out' : 'animate-modal-in'
        }`}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <CardContent className={`p-0 flex flex-col${capHeight ? ' min-h-0' : ''}`}>
          {header}
          {children}
        </CardContent>
      </Card>
    </div>
  );
}
