import { useEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { focusRingCls } from '../formStyles';

/** ⓘ toggle that reveals a formula panel. Click-driven (the app's Tooltip is
 *  hover/focus only); closes on Escape and on a pointerdown outside. */
export function FormulaPopover({ label, lines }: { label: string; lines: string[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onDown = (e: Event) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open]);
  return (
    <span ref={rootRef} className="relative inline-flex">
      <button
        type="button" aria-label={label} aria-expanded={open} aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        className={`rounded p-0.5 text-bambu-gray hover:text-white ${focusRingCls}`}
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open && (
        <div role="dialog" aria-label={label}
          className="absolute left-0 top-full z-20 mt-1 w-max max-w-[min(90vw,28rem)] rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary p-3 shadow-xl">
          {lines.map((l, i) => (
            <p key={i} className="whitespace-pre font-mono text-xs tabular-nums text-white">{l}</p>
          ))}
        </div>
      )}
    </span>
  );
}
