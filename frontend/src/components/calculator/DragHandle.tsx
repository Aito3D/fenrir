// A draggable vertical handle for one x-value of a recharts LineChart (the
// K / KQ reference lines). Renders inside the chart's SVG: a wide invisible
// hit strip the full plot height and a small grip at the top. Pointer
// capture keeps the drag alive outside the chart; arrow keys step it.
import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { usePlotArea } from 'recharts';
import { xToValue } from './curveGeometry';

const STRIP_W = 24;
const GRIP = 12;

export function DragHandle({
  value, min, max, onChange, round, label, readOnly, ariaValue, onDragStart, onDragEnd,
}: {
  value: number; min: number; max: number;
  onChange: (v: number) => void;
  round: (v: number) => number;
  label: string;
  readOnly?: boolean;
  /** Overrides the `aria-valuenow` announced to assistive tech — for the KQ
   *  handle, which visually sits at `kq + 1` (the ReferenceLine's x) but
   *  whose underlying field value is `kq`. Defaults to `value`. */
  ariaValue?: number;
  /** Fired on pointerdown / pointerup(-cancel), before the corresponding
   *  `onChange`. Lets a caller whose `min`/`max` domain is derived from the
   *  dragged value itself (e.g. a domain that scales with K) freeze that
   *  domain for the lifetime of one drag — otherwise every `onChange` moves
   *  the domain the very next move is measured against, compounding. */
  onDragStart?: () => void;
  onDragEnd?: () => void;
}) {
  // `useOffset()` only carries the top/left/right/bottom distances in this
  // recharts version, not width/height — `usePlotArea()` is the hook that
  // also exposes the plot's pixel width/height (`x`/`y` mirror `offset.left`
  // / `offset.top`, per recharts' own docs on the two hooks).
  const plotArea = usePlotArea();
  const stripRef = useRef<SVGRectElement>(null);
  if (!plotArea || plotArea.width <= 0) return null;
  const { x: left, y: top, width, height } = plotArea;
  const span = max - min;
  const x = span > 0 ? left + ((Math.min(max, Math.max(min, value)) - min) / span) * width : left;

  if (readOnly) return null;

  const valueAt = (clientX: number) => {
    const svg = stripRef.current?.ownerSVGElement;
    const svgLeft = svg?.getBoundingClientRect().left ?? 0;
    return round(xToValue(clientX - svgLeft, left, width, min, max));
  };
  const onPointerDown = (e: PointerEvent<SVGGElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    onDragStart?.();
    onChange(valueAt(e.clientX));
  };
  const onPointerMove = (e: PointerEvent<SVGGElement>) => {
    if (e.buttons === 0 && !e.currentTarget.hasPointerCapture?.(e.pointerId)) return;
    onChange(valueAt(e.clientX));
  };
  const onPointerUp = (e: PointerEvent<SVGGElement>) => {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    onDragEnd?.();
  };
  const onKeyDown = (e: KeyboardEvent<SVGGElement>) => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    // `onDragStart` being wired up is the same signal the pointer path uses
    // to detect "this handle's own domain scales with the value it drags"
    // (see the prop's JSDoc above) — e.g. the K handle's `max` is `k * 10`.
    // A step sized as a percentage of `span` in that case re-derives from a
    // domain the very last `onChange` just moved, compounding every
    // keypress (T-022): a 10 % step of `span` is actually a 100 % step of
    // `value`, doubling it. Step by a fixed, value-independent amount
    // instead — one unit of the same order-of-magnitude grid `round` snaps
    // values to (mirrors roundK's own digit scale) — so repeated presses
    // add/subtract a constant and ArrowRight/ArrowLeft exactly cancel.
    // Handles whose domain doesn't depend on their own value (e.g. KQ, which
    // passes no `onDragStart`) keep the original percent-of-span step.
    //
    // The step must be sized from the decade of the value being stepped
    // TOWARD, not the value being stepped FROM — `round` (roundK) always
    // snaps its input to ITS OWN decade, so at an exact decade boundary
    // (e.g. 10) the two decades disagree: sizing the ArrowLeft step from
    // `value`'s decade (10 → scale 1) undershoots the fine-grid neighbor
    // (9.99) that ArrowRight would have produced from it, breaking the
    // exact-cancellation property this comment promises. Nudging the value
    // down by an epsilon before taking its decade (for dir < 0 only) makes
    // an exact power of ten read as belonging to the decade just below it —
    // the same decade the destination value will land in — so ArrowRight
    // and ArrowLeft are exact inverses even across a decade boundary.
    let step: number;
    if (onDragStart) {
      const basisValue = dir < 0 ? value * (1 - 1e-9) : value;
      const basis = Number.isFinite(basisValue) && basisValue >= 1 ? basisValue : 1;
      const scale = 10 ** (Math.floor(Math.log10(basis)) - 2);
      step = scale * (e.shiftKey ? 10 : 1) * dir;
    } else {
      step = span * (e.shiftKey ? 0.1 : 0.01) * dir;
    }
    onChange(round(Math.min(max, Math.max(min, value + step))));
  };

  return (
    <g
      style={{ touchAction: 'none' }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
    >
      <rect
        ref={stripRef}
        data-testid="drag-strip"
        x={x - STRIP_W / 2} y={top} width={STRIP_W} height={height}
        fill="transparent" style={{ cursor: 'ew-resize' }}
      />
      <g
        role="slider" aria-orientation="horizontal" tabIndex={0} aria-label={label} aria-valuenow={ariaValue ?? value} aria-valuemin={min} aria-valuemax={max}
        onKeyDown={onKeyDown} className="outline-none focus-visible:[&>rect]:stroke-white"
      >
        <rect x={x - GRIP / 2} y={top} width={GRIP} height={GRIP} rx={3} fill="var(--color-bambu-green)" stroke="var(--color-bambu-dark-secondary)" strokeWidth={2} style={{ cursor: 'ew-resize' }} />
      </g>
    </g>
  );
}
