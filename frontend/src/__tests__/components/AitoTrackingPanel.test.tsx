/**
 * `useSheetDrag()` — the drag-to-dismiss gesture on `TrackingPanel`'s header,
 * active only when the panel is rendered as a phone bottom sheet
 * (`SHEET_QUERY`, `max-width: 1119px`) and motion isn't reduced.
 *
 * jsdom has no `Element.prototype.setPointerCapture` at all (throws "is not
 * a function"), so it's stubbed globally for this file the same way a
 * missing DOM API gets stubbed elsewhere in this suite. `offsetHeight` is
 * always 0 in jsdom, so it's defined per-test via `Object.defineProperty`
 * (documented in the task brief).
 *
 * `window.matchMedia` is replaced wholesale per test (the `useMediaQuery`
 * hook tests' pattern) rather than the default setup.ts stub (always
 * `matches: false`), because `useSheetDrag` reads two different queries —
 * the sheet breakpoint and `prefers-reduced-motion` — and needs to
 * distinguish them.
 *
 * The velocity term (`(y1 - y0) / (t1 - t0)`, "downward positive") is driven
 * by mocking `performance.now()`: jsdom dispatches synthetic events fast
 * enough that two calls can land in the same millisecond, which the
 * component treats as zero velocity (`t1 > t0 ? ... : 0`) — not exercising
 * the velocity branch at all unless the clock is controlled.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { render } from '../utils';
import { TrackingPanel } from '../../components/aito/TrackingPanel';

// jsdom here has no global `PointerEvent` — `fireEvent.pointerDown` falls
// back to the plain `Event` constructor, which silently drops `clientY`/
// `pointerId` from the init dict (confirmed via DragHandle.test.tsx's own
// header note). This gesture can't be observed numerically without it.
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

function mockMatchMedia({ sheet, reduced }: { sheet: boolean; reduced: boolean }) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? reduced : sheet,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

let originalMatchMedia: typeof window.matchMedia;
let originalSetPointerCapture: typeof Element.prototype.setPointerCapture | undefined;

beforeEach(() => {
  originalMatchMedia = window.matchMedia;
  originalSetPointerCapture = Element.prototype.setPointerCapture;
  Element.prototype.setPointerCapture = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  window.matchMedia = originalMatchMedia;
  if (originalSetPointerCapture) Element.prototype.setPointerCapture = originalSetPointerCapture;
  vi.restoreAllMocks();
});

function renderPanel() {
  const onClose = vi.fn();
  render(
    <TrackingPanel
      id="sheet"
      side="right"
      open
      title="Livraison"
      titleRef={() => {}}
      onClose={onClose}
      testId="track-sheet-under-test"
    >
      <div>content</div>
    </TrackingPanel>
  );
  const panel = document.querySelector('[data-testid="track-sheet-under-test"]') as HTMLElement;
  Object.defineProperty(panel, 'offsetHeight', { value: 400, configurable: true });
  const header = panel.querySelector('.touch-none') as HTMLElement;
  return { panel, header, onClose };
}

describe('useSheetDrag (TrackingPanel bottom-sheet drag)', () => {
  it('is a no-op below the sheet breakpoint: no transform, no dismissal', () => {
    mockMatchMedia({ sheet: false, reduced: false });
    const { panel, header, onClose } = renderPanel();

    fireEvent.pointerDown(header, { clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(header, { clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(header, { clientY: 300, pointerId: 1 });

    expect(panel.style.transform).toBe('');
    expect(panel.style.transition).toBe('');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('is a no-op under reduced motion even though the sheet breakpoint matches', () => {
    mockMatchMedia({ sheet: true, reduced: true });
    const { panel, header, onClose } = renderPanel();

    fireEvent.pointerDown(header, { clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(header, { clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(header, { clientY: 300, pointerId: 1 });

    expect(panel.style.transform).toBe('');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not start a drag when the pointer goes down on the close button', () => {
    mockMatchMedia({ sheet: true, reduced: false });
    const { panel, header, onClose } = renderPanel();
    const closeButton = header.querySelector('button') as HTMLElement;

    fireEvent.pointerDown(closeButton, { clientY: 0, pointerId: 1 });
    // Even a subsequent move on the header itself must not pick up a drag
    // that was never started.
    fireEvent.pointerMove(header, { clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(header, { clientY: 300, pointerId: 1 });

    expect(panel.style.transform).toBe('');
    expect(panel.style.transition).toBe('');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('follows the pointer 1:1 while dragging and tracks progress as a custom property', () => {
    mockMatchMedia({ sheet: true, reduced: false });
    const { panel, header } = renderPanel();

    fireEvent.pointerDown(header, { clientY: 100, pointerId: 1 });
    expect(panel.style.transition).toBe('none');

    fireEvent.pointerMove(header, { clientY: 150, pointerId: 1 });

    expect(panel.style.transform).toBe('translateY(50px)');
    // offsetHeight stubbed to 400: progress = 1 - 50/400 = 0.875.
    expect(panel.style.getPropertyValue('--track-sheet-progress')).toBe('0.875');
  });

  it('a short, slow drag springs back: no dismissal, and pointercancel clears the inline styles', () => {
    mockMatchMedia({ sheet: true, reduced: false });
    const { panel, header, onClose } = renderPanel();

    // Real render/mount work (React scheduling, MSW, etc.) calls
    // `performance.now()` far too many times to script with
    // `mockReturnValueOnce`; fake timers freeze the clock instead, so it
    // only moves when `advanceTimersByTime` says so.
    vi.useFakeTimers();
    fireEvent.pointerDown(header, { clientY: 0, pointerId: 1 });
    vi.advanceTimersByTime(1000); // far too slow to read as a flick
    fireEvent.pointerMove(header, { clientY: 50, pointerId: 1 }); // 50px < 45% of 400px
    fireEvent.pointerCancel(header, { clientY: 50, pointerId: 1 });
    vi.useRealTimers();

    expect(onClose).not.toHaveBeenCalled();
    expect(panel.style.transform).toBe('');
    expect(panel.style.transition).toBe('');
    expect(panel.style.getPropertyValue('--track-sheet-progress')).toBe('');
  });

  it('dragging past 45% of the sheet height dismisses on release, regardless of speed', () => {
    mockMatchMedia({ sheet: true, reduced: false });
    const { panel, header, onClose } = renderPanel();

    vi.useFakeTimers();
    fireEvent.pointerDown(header, { clientY: 0, pointerId: 1 });
    vi.advanceTimersByTime(1000); // slow, but far enough
    fireEvent.pointerMove(header, { clientY: 200, pointerId: 1 }); // 200px > 45% of 400px (180px)
    fireEvent.pointerUp(header, { clientY: 200, pointerId: 1 });
    vi.useRealTimers();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(panel.style.transform).toBe('');
  });

  it('a fast downward flick dismisses on release even short of the 45% distance', () => {
    mockMatchMedia({ sheet: true, reduced: false });
    const { panel, header, onClose } = renderPanel();

    vi.useFakeTimers();
    fireEvent.pointerDown(header, { clientY: 0, pointerId: 1 });
    vi.advanceTimersByTime(10);
    // 20px in 10ms = 2 px/ms, well past the 0.45 px/ms threshold; distance
    // (20px) stays far under 45% of the 400px stubbed height.
    fireEvent.pointerMove(header, { clientY: 20, pointerId: 1 });
    fireEvent.pointerUp(header, { clientY: 20, pointerId: 1 });
    vi.useRealTimers();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(panel.style.transform).toBe('');
  });
});
