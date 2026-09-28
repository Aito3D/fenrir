import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useInfiniteScrollSentinel } from '../../hooks/useInfiniteScrollSentinel';

type Callback = (entries: Array<{ isIntersecting: boolean }>) => void;
const created: Array<{ cb: Callback; options: IntersectionObserverInit; disconnect: ReturnType<typeof vi.fn> }> = [];

beforeEach(() => {
  created.length = 0;
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
      constructor(cb: Callback, options: IntersectionObserverInit) {
        created.push({ cb, options, disconnect: this.disconnect });
      }
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

// jsdom does no layout, so every element reports 0 for scrollHeight and
// clientHeight; tests that need a clipping box stub them per element.
function setBox(el: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
}

function Harness({ enabled, onReach }: { enabled: boolean; onReach: () => void }) {
  const sentinelRef = useInfiniteScrollSentinel({ enabled, onReach });
  return (
    <div data-testid="outer">
      <div data-testid="pane">
        <div data-testid="list">
          <div ref={sentinelRef} data-testid="sentinel" />
        </div>
      </div>
    </div>
  );
}

describe('useInfiniteScrollSentinel', () => {
  it('calls onReach when the sentinel intersects', () => {
    const onReach = vi.fn();
    render(<Harness enabled onReach={onReach} />);
    expect(created).toHaveLength(1);
    act(() => created[0].cb([{ isIntersecting: false }]));
    expect(onReach).not.toHaveBeenCalled();
    act(() => created[0].cb([{ isIntersecting: true }]));
    expect(onReach).toHaveBeenCalledTimes(1);
  });

  it('creates no observer while disabled and a fresh one when re-enabled', () => {
    const onReach = vi.fn();
    const { rerender } = render(<Harness enabled={false} onReach={onReach} />);
    expect(created).toHaveLength(0);
    rerender(<Harness enabled onReach={onReach} />);
    expect(created).toHaveLength(1);
    rerender(<Harness enabled={false} onReach={onReach} />);
    expect(created[0].disconnect).toHaveBeenCalled();
  });

  it('uses the nearest clipping scrollable ancestor as root, with a margin from its clientHeight', () => {
    const { getByTestId, rerender } = render(<Harness enabled={false} onReach={() => {}} />);
    const outer = getByTestId('outer');
    const pane = getByTestId('pane');
    // The outer box also clips, but the pane is nearer and must win.
    outer.style.overflowY = 'auto';
    setBox(outer, 5000, 900);
    pane.style.overflowY = 'auto';
    setBox(pane, 3000, 400);
    rerender(<Harness enabled onReach={() => {}} />);
    expect(created).toHaveLength(1);
    expect(created[0].options.root).toBe(pane);
    expect(created[0].options.rootMargin).toBe('0px 0px 600px 0px');
  });

  it('ignores a scrollable-styled ancestor that does not clip and falls back to the viewport', () => {
    const { getByTestId, rerender } = render(<Harness enabled={false} onReach={() => {}} />);
    const pane = getByTestId('pane');
    // Below `lg` the pane keeps overflow auto in some shells but grows with
    // its rows: scrollHeight === clientHeight, so it never scrolls.
    pane.style.overflowY = 'auto';
    setBox(pane, 3000, 3000);
    rerender(<Harness enabled onReach={() => {}} />);
    expect(created).toHaveLength(1);
    expect(created[0].options.root).toBeNull();
    expect(created[0].options.rootMargin).toBe(`0px 0px ${Math.round(window.innerHeight * 1.5)}px 0px`);
  });

  it('uses the viewport when no ancestor scrolls', () => {
    render(<Harness enabled onReach={() => {}} />);
    expect(created[0].options.root).toBeNull();
    expect(created[0].options.rootMargin).toBe(`0px 0px ${Math.round(window.innerHeight * 1.5)}px 0px`);
  });

  it('re-resolves the root on resize, once per animation frame, and only while enabled', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const { getByTestId, rerender } = render(<Harness enabled onReach={() => {}} />);
    expect(created).toHaveLength(1);
    expect(created[0].options.root).toBeNull();

    // Crossing the breakpoint makes the pane clip; three resize events in
    // one frame schedule a single re-observe.
    const pane = getByTestId('pane');
    pane.style.overflowY = 'auto';
    setBox(pane, 3000, 500);
    act(() => {
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('resize'));
    });
    expect(frames).toHaveLength(1);
    act(() => frames.splice(0).forEach((cb) => cb(0)));
    expect(created).toHaveLength(2);
    expect(created[0].disconnect).toHaveBeenCalled();
    expect(created[1].options.root).toBe(pane);
    expect(created[1].options.rootMargin).toBe('0px 0px 750px 0px');

    rerender(<Harness enabled={false} onReach={() => {}} />);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(frames).toHaveLength(0);
  });

  it('always calls the latest onReach without re-observing', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Harness enabled onReach={first} />);
    rerender(<Harness enabled onReach={second} />);
    expect(created).toHaveLength(1);
    act(() => created[0].cb([{ isIntersecting: true }]));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
