import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DragHandle } from '../../../components/calculator/DragHandle';
import { roundK } from '../../../components/calculator/curveGeometry';

// `DragHandle` reads plot geometry from `usePlotArea()` (the installed
// recharts' `useOffset()` carries only top/left/right/bottom, not
// width/height — see the comment in DragHandle.tsx). `x`/`y` here mirror
// `offset.left`/`offset.top`.
vi.mock('recharts', async (orig) => ({
  ...(await orig<typeof import('recharts')>()),
  usePlotArea: () => ({ x: 50, y: 0, width: 200, height: 100 }),
}));

// jsdom here has no global `PointerEvent` (confirmed elsewhere in this repo —
// see AitoBoardColumnDrag.test.tsx's header note). Testing-library's
// `fireEvent.pointerDown` falls back to the plain `Event` constructor in
// that case, which silently drops `clientX`/`buttons`/`pointerId` from the
// init dict — a real drag can't be observed numerically without this. A
// minimal polyfill (kept local to this file; no other suite drives a real
// pointer drag with coordinates) restores just enough of the shape.
class PointerEventPolyfill extends MouseEvent {
  pointerId: number;
  constructor(type: string, params: PointerEventInit = {}) {
    super(type, params);
    this.pointerId = params.pointerId ?? 0;
  }
}
if (typeof window.PointerEvent === 'undefined') {
  // @ts-expect-error jsdom does not ship a PointerEvent constructor
  window.PointerEvent = PointerEventPolyfill;
}

describe('DragHandle', () => {
  it('maps a pointer drag across the plot to a value and rounds it', () => {
    const onChange = vi.fn();
    render(<svg><DragHandle value={500} min={0} max={1000} onChange={onChange} round={(v) => Math.round(v)} label="Drag to set K" /></svg>);
    const grip = screen.getByRole('slider', { name: 'Drag to set K' });
    const strip = grip.parentElement!.querySelector('[data-testid="drag-strip"]')!;
    fireEvent.pointerDown(strip, { clientX: 150, pointerId: 1 });
    // `buttons: 1` — jsdom's pointer events have no real capture state, so
    // the handler's `e.buttons === 0` guard (meant to ignore a hover move
    // with no button held) would otherwise drop this move entirely.
    fireEvent.pointerMove(strip, { clientX: 200, pointerId: 1, buttons: 1 });
    fireEvent.pointerUp(strip, { pointerId: 1 });
    // The svg's bounding rect is 0 in jsdom, so plot-left is 50 and x=200 → 75 % → 750.
    expect(onChange).toHaveBeenLastCalledWith(750);
  });
  it('maps a pointer drag on the grip itself (not just the strip) to a value', () => {
    const onChange = vi.fn();
    render(<svg><DragHandle value={500} min={0} max={1000} onChange={onChange} round={(v) => Math.round(v)} label="Drag to set K" /></svg>);
    const grip = screen.getByRole('slider', { name: 'Drag to set K' });
    const gripRect = grip.querySelector('rect')!;
    fireEvent.pointerDown(gripRect, { clientX: 150, pointerId: 1 });
    fireEvent.pointerMove(gripRect, { clientX: 200, pointerId: 1, buttons: 1 });
    fireEvent.pointerUp(gripRect, { pointerId: 1 });
    // Same mapping as the strip test: svg bounding rect is 0 in jsdom, plot-left
    // is 50, x=200 → 75 % → 750.
    expect(onChange).toHaveBeenLastCalledWith(750);
  });
  it('steps with the keyboard: 1 % per arrow, 10 % with shift', () => {
    const onChange = vi.fn();
    render(<svg><DragHandle value={500} min={0} max={1000} onChange={onChange} round={(v) => v} label="Drag to set K" /></svg>);
    const grip = screen.getByRole('slider', { name: 'Drag to set K' });
    fireEvent.keyDown(grip, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(510);
    fireEvent.keyDown(grip, { key: 'ArrowLeft', shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(400);
  });
  // T-047: the `onDragStart`-gated keyboard step is sized from the decade
  // of the value being stepped TOWARD, not FROM, so it stays an exact
  // inverse of itself across a decade boundary (10 <-> 9.99) — not just
  // within one decade, which the panel-level regression test above already
  // covers away from any boundary.
  it('round-trips exactly across a decade boundary with onDragStart wired (K-style handle)', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <svg>
        <DragHandle value={10} min={0} max={100} onChange={onChange} round={roundK} label="Drag to set K" onDragStart={() => {}} />
      </svg>,
    );
    const grip = screen.getByRole('slider', { name: 'Drag to set K' });
    // From an exact decade value, ArrowLeft now moves one fine-grid step
    // (to 9.99) instead of the old coarse step (to 9.9) — the approved
    // user-visible change.
    fireEvent.keyDown(grip, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith(9.99);
    rerender(
      <svg>
        <DragHandle value={9.99} min={0} max={100} onChange={onChange} round={roundK} label="Drag to set K" onDragStart={() => {}} />
      </svg>,
    );
    fireEvent.keyDown(grip, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(10);
  });
  it('ignores a hover move with no button held and no pointer capture', () => {
    const onChange = vi.fn();
    render(<svg><DragHandle value={500} min={0} max={1000} onChange={onChange} round={(v) => Math.round(v)} label="Drag to set K" /></svg>);
    const grip = screen.getByRole('slider', { name: 'Drag to set K' });
    const strip = grip.parentElement!.querySelector('[data-testid="drag-strip"]')!;
    // No prior pointerDown, and `buttons: 0` — the handler's guard should
    // treat this as a plain hover and drop it without calling `onChange`.
    fireEvent.pointerMove(strip, { clientX: 200, pointerId: 1, buttons: 0 });
    expect(onChange).not.toHaveBeenCalled();
  });
  it('no-ops on a keydown that is not an arrow key', () => {
    const onChange = vi.fn();
    render(<svg><DragHandle value={500} min={0} max={1000} onChange={onChange} round={(v) => v} label="Drag to set K" /></svg>);
    const grip = screen.getByRole('slider', { name: 'Drag to set K' });
    fireEvent.keyDown(grip, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });
  it('renders nothing interactive when read-only', () => {
    render(<svg><DragHandle value={500} min={0} max={1000} onChange={() => {}} round={(v) => v} label="Drag to set K" readOnly /></svg>);
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });
});
