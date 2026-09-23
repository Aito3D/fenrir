import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/** Small accessible tooltip: shows on hover AND keyboard focus (unlike a bare
 *  `title` attribute), links trigger → content via aria-describedby, and
 *  shifts horizontally so it never clips outside the viewport. */
export function Tooltip({
  content,
  children,
  align = 'center',
  side = 'top',
}: {
  content: string;
  children: ReactNode;
  /** Where the bubble hangs from. `center` (default) sits over the middle
   *  of the trigger. `end` aligns the bubble's right edge with the
   *  trigger's, so it grows leftward — for a trigger at the right edge of a
   *  clipping column (TaskRow's pencil/remove pair inside the panel's
   *  scrolling task column), where a centred bubble loses its right half to
   *  `overflow` before the viewport shift below ever sees it. `start` is the
   *  mirror: the bubble's left edge on the trigger's, growing rightward, for
   *  a trigger near the LEFT edge of a clipping container (the masthead's
   *  rating pill). */
  align?: 'center' | 'end' | 'start';
  /** Which side of the trigger the bubble sits on. `top` (default) hangs it
   *  above. `bottom` for a trigger on the first row of a clipped container:
   *  the project panel's root is `overflow-hidden` (load-bearing), so a
   *  bubble above its masthead is cut off entirely — HoldButton's
   *  `hintPlacement="bottom"` exists for the same reason. The viewport shift
   *  below corrects horizontally only; it never sees an ancestor's overflow. */
  side?: 'top' | 'bottom';
}) {
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

  // The settle-in travels from the trigger outward, so the resting offset
  // starts on the trigger's side: 3px down when hanging above, 3px up when
  // sitting below.
  const restY = side === 'bottom' ? '-3px' : '3px';
  const translateX = align === 'center' ? `translateX(calc(-50% + ${shift}px))` : `translateX(${shift}px)`;
  const alignCls = align === 'end' ? 'right-0' : align === 'start' ? 'left-0' : 'left-1/2';
  const sideCls = side === 'bottom' ? 'top-full mt-1.5' : 'bottom-full mb-1.5';

  return (
    <span
      // A NAMED group: `group-hover` alone would also match any ancestor
      // `.group` — TaskRow's card is one (its remove icon reveals on row
      // hover), and two tooltips in one card both lit up on a card hover.
      className="group/tip relative inline-flex"
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
        style={{ transform: `${translateX} translateY(var(--tip-y, ${restY}))` }}
        className={`pointer-events-none absolute ${sideCls} ${alignCls} z-50 w-max max-w-[16rem] rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary px-2.5 py-1.5 text-left text-xs font-normal normal-case tracking-normal text-bambu-gray-light shadow-lg opacity-0 transition-[opacity,transform] duration-150 ease-out group-hover/tip:opacity-100 group-hover/tip:[--tip-y:0px] group-focus-visible/tip:opacity-100 group-focus-visible/tip:[--tip-y:0px] motion-reduce:transition-opacity`}
      >
        {content}
      </span>
    </span>
  );
}
