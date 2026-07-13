import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/** Small accessible tooltip: shows on hover AND keyboard focus (unlike a bare
 *  `title` attribute), links trigger → content via aria-describedby, and
 *  shifts horizontally so it never clips outside the viewport. */
export function Tooltip({ content, children }: { content: string; children: ReactNode }) {
  const id = useId();
  const tipRef = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);

  // The tooltip node is always mounted (opacity-0), so it is measurable the
  // moment the pointer/focus arrives; the rect already includes the current
  // shift, so the correction is additive.
  const reposition = () => {
    const el = tipRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    let dx = 0;
    if (rect.left < margin) dx = margin - rect.left;
    else if (rect.right > window.innerWidth - margin) dx = window.innerWidth - margin - rect.right;
    if (dx !== 0) setShift((s) => s + dx);
  };
  const reset = () => setShift(0);

  return (
    <span
      className="group relative inline-flex"
      tabIndex={0}
      aria-describedby={id}
      onMouseEnter={reposition}
      onFocus={reposition}
      onMouseLeave={reset}
      onBlur={reset}
    >
      {children}
      <span
        role="tooltip"
        id={id}
        ref={tipRef}
        style={{ transform: `translateX(calc(-50% + ${shift}px))` }}
        className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 w-max max-w-[16rem] rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary px-2.5 py-1.5 text-left text-xs font-normal normal-case tracking-normal text-bambu-gray-light shadow-lg opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
      >
        {content}
      </span>
    </span>
  );
}
