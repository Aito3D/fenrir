import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DragHandle } from '../../../components/calculator/DragHandle';

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
  it('steps with the keyboard: 1 % per arrow, 10 % with shift', () => {
    const onChange = vi.fn();
    render(<svg><DragHandle value={500} min={0} max={1000} onChange={onChange} round={(v) => v} label="Drag to set K" /></svg>);
    const grip = screen.getByRole('slider', { name: 'Drag to set K' });
    fireEvent.keyDown(grip, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(510);
    fireEvent.keyDown(grip, { key: 'ArrowLeft', shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(400);
  });
  it('renders nothing interactive when read-only', () => {
    render(<svg><DragHandle value={500} min={0} max={1000} onChange={() => {}} round={(v) => v} label="Drag to set K" readOnly /></svg>);
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });
});
