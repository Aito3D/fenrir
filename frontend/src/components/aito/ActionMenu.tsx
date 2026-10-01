import { Fragment, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import type { LucideIcon } from 'lucide-react';
import { useDismissableDialog } from '../../hooks/useDismissableDialog';

export interface ActionMenuItem {
  key: string;
  icon: LucideIcon;
  label: string;
  trailing?: ReactNode;
  onSelect: () => void;
  /** Muted and inert; `hint` says why on a second line. */
  disabled?: boolean;
  hint?: string;
  /** A rule above the row, to set it apart from the ones before it. */
  separatorBefore?: boolean;
  /** Red text, for the destructive row (Trash). */
  danger?: boolean;
}

/** A small menu anchored to the button that opened it — the phone board's ⋯
 *  detours, the create button's two choices and the open card's actions.
 *  Mount only while open. */
export function ActionMenu({
  label,
  anchorRef,
  placement,
  caption,
  items,
  onClose,
}: {
  label: string;
  anchorRef: RefObject<HTMLElement | null>;
  placement: 'below' | 'above';
  caption?: ReactNode;
  items: ActionMenuItem[];
  onClose: () => void;
}) {
  const { closing, requestClose, dialogRef } = useDismissableDialog(onClose, { animationMs: 120 });
  // Measured once, at open: the anchor does not move while its menu is up.
  const [position] = useState<CSSProperties>(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return { top: 104, right: 12 };
    const right = Math.max(8, window.innerWidth - rect.right);
    return placement === 'below' ? { top: rect.bottom + 6, right } : { bottom: window.innerHeight - rect.top + 8, right };
  });

  return (
    <div className="fixed inset-0 z-50">
      <div
        data-testid="aito-action-menu-scrim"
        onClick={requestClose}
        className={`absolute inset-0 bg-black/30 ${closing ? 'animate-overlay-out' : 'animate-overlay-in'}`}
      />
      <div
        ref={dialogRef}
        role="menu"
        aria-label={label}
        tabIndex={-1}
        style={position}
        className={`absolute min-w-[13.5rem] rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-1.5 shadow-2xl focus:outline-none ${
          placement === 'below' ? 'origin-top-right' : 'origin-bottom-right'
        } ${closing ? 'animate-pop-out' : 'animate-pop-in'}`}
      >
        {caption && (
          <>
            <div className="flex flex-wrap items-center gap-1.5 px-2.5 pt-2 pb-2 text-xs text-bambu-gray">{caption}</div>
            <div role="separator" className="mx-1.5 mb-1 border-t border-bambu-dark-tertiary" />
          </>
        )}
        {items.map(
          ({ key, icon: Icon, label: itemLabel, trailing, onSelect, disabled, hint, separatorBefore, danger }) => (
            <Fragment key={key}>
              {separatorBefore && <div role="separator" className="mx-1.5 my-1 border-t border-bambu-dark-tertiary" />}
              <button
                type="button"
                role="menuitem"
                aria-disabled={disabled || undefined}
                onClick={() => {
                  if (disabled) return;
                  onSelect();
                  onClose();
                }}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2.5 rounded-lg text-left text-sm active:bg-bambu-dark-tertiary focus-visible:outline-none focus-visible:bg-bambu-dark-tertiary ${
                  disabled ? 'opacity-50 cursor-default' : ''
                } ${danger ? 'text-red-400' : 'text-white'}`}
              >
                <Icon className="w-4 h-4 flex-none text-bambu-gray-light" aria-hidden="true" />
                <span className="flex-1">
                  {itemLabel}
                  {hint && <span className="block text-[11px] text-bambu-gray">{hint}</span>}
                </span>
                {trailing !== undefined && <span className="text-xs text-bambu-gray tabular-nums">{trailing}</span>}
              </button>
            </Fragment>
          ),
        )}
      </div>
    </div>
  );
}
