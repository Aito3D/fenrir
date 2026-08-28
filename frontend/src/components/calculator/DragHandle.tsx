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
  value, min, max, onChange, round, label, readOnly,
}: {
  value: number; min: number; max: number;
  onChange: (v: number) => void;
  round: (v: number) => number;
  label: string;
  readOnly?: boolean;
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
  const onPointerDown = (e: PointerEvent<SVGRectElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    onChange(valueAt(e.clientX));
  };
  const onPointerMove = (e: PointerEvent<SVGRectElement>) => {
    if (e.buttons === 0 && !e.currentTarget.hasPointerCapture?.(e.pointerId)) return;
    onChange(valueAt(e.clientX));
  };
  const onPointerUp = (e: PointerEvent<SVGRectElement>) => e.currentTarget.releasePointerCapture?.(e.pointerId);
  const onKeyDown = (e: KeyboardEvent<SVGGElement>) => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const step = span * (e.shiftKey ? 0.1 : 0.01) * dir;
    onChange(round(Math.min(max, Math.max(min, value + step))));
  };

  return (
    <g>
      <rect
        ref={stripRef}
        data-testid="drag-strip"
        x={x - STRIP_W / 2} y={top} width={STRIP_W} height={height}
        fill="transparent" style={{ cursor: 'ew-resize', touchAction: 'none' }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      />
      <g
        role="button" tabIndex={0} aria-label={label} aria-valuenow={value} aria-valuemin={min} aria-valuemax={max}
        onKeyDown={onKeyDown} className="outline-none focus-visible:[&>rect]:stroke-white"
      >
        <rect x={x - GRIP / 2} y={top} width={GRIP} height={GRIP} rx={3} fill="var(--color-bambu-green)" stroke="transparent" strokeWidth={2} style={{ cursor: 'ew-resize' }} />
      </g>
    </g>
  );
}
