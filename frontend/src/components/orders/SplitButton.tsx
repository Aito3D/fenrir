import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { focusRingCls } from '../formStyles';

const PRESS_MS = 500;

export interface SplitItem {
  key: string;
  label: string;
  hint?: string;
  /** Makes the item aria-disabled: selecting it shows this instead of running `onSelect`. */
  disabledReason?: string;
  onSelect: () => void;
}

/** A main action with an arrow on its LEFT. The menu opens from the arrow or a 500 ms press on the main button;
 *  Escape and a click outside close it. `className` styles both halves (colour, height). */
export function SplitButton({ label, onClick, ariaDisabled, busy, className = '', menuLabel, items, menuBelow }: {
  label: ReactNode;
  onClick: () => void;
  ariaDisabled?: boolean;
  busy?: boolean;
  className?: string;
  menuLabel: string;
  items: SplitItem[];
  /** Opens the menu under the button instead of over it. */
  menuBelow?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  // True once a press became a long press: the click that follows its release must not run the main action.
  const held = useRef(false);
  const menu = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    setReason(null);
  };

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  // On a phone a menu opening downward at the bottom of the screen ends below the viewport.
  useEffect(() => {
    if (open) menu.current?.scrollIntoView?.({ block: 'nearest' });
  }, [open]);

  const cancelPress = () => window.clearTimeout(timer.current);
  const select = (item: SplitItem) => {
    if (item.disabledReason) {
      setReason(item.disabledReason);
      return;
    }
    close();
    item.onSelect();
  };

  return (
    <div
      ref={root}
      className="relative flex flex-1"
      onKeyDown={e => {
        if (e.key === 'Escape' && open) {
          // Stops the dialog's own window-level Escape from closing the whole modal as well.
          e.stopPropagation();
          close();
        }
      }}
    >
      <button
        type="button"
        aria-label={menuLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setReason(null);
          setOpen(o => !o);
        }}
        className={`btn-press inline-flex w-11 flex-shrink-0 items-center justify-center rounded-l-lg border-r border-black/30 ${className} ${focusRingCls}`}
      >
        <ChevronDown aria-hidden="true" className="h-4 w-4" />
      </button>
      <button
        type="button"
        // Not `disabled`: the click on a blocked button is what says why.
        aria-disabled={ariaDisabled || busy || undefined}
        onPointerDown={() => {
          held.current = false;
          timer.current = window.setTimeout(() => {
            held.current = true;
            setOpen(true);
          }, PRESS_MS);
        }}
        onPointerUp={cancelPress}
        onPointerLeave={cancelPress}
        onPointerCancel={cancelPress}
        onClick={() => {
          if (held.current) {
            held.current = false;
            return;
          }
          if (!busy) onClick();
        }}
        className={`btn-press inline-flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-r-lg px-5 text-sm font-semibold ${className} ${focusRingCls}`}
      >
        {busy && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
        {label}
      </button>
      {open && (
        <div ref={menu} role="menu" className={`absolute left-0 right-0 z-20 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary p-1.5 shadow-xl animate-aito-pop-in ${menuBelow ? 'top-full mt-2 origin-top-left' : 'bottom-full mb-2 origin-bottom-left'}`}>
          {items.map(item => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              aria-disabled={!!item.disabledReason || undefined}
              onClick={() => select(item)}
              className={`block w-full rounded-md px-3 py-2 text-left text-sm text-white hover:bg-bambu-dark-tertiary ${item.disabledReason ? 'opacity-45' : ''} ${focusRingCls}`}
            >
              {item.label}
              {item.hint && <span className="block text-xs text-bambu-gray">{item.hint}</span>}
            </button>
          ))}
          {reason && <p role="alert" className="px-3 pb-1 pt-1.5 text-xs text-amber-400">{reason}</p>}
        </div>
      )}
    </div>
  );
}
