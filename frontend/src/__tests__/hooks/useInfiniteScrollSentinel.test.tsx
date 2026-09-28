import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useRef } from 'react';
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

function Harness({ enabled, onReach, withRoot = false }: { enabled: boolean; onReach: () => void; withRoot?: boolean }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useInfiniteScrollSentinel({ rootRef: withRoot ? rootRef : undefined, enabled, onReach });
  return (
    <div ref={rootRef} style={{ height: 400 }}>
      <div ref={sentinelRef} data-testid="sentinel" />
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

  it('observes inside the scroll container with a look-ahead margin', () => {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
    render(<Harness enabled onReach={() => {}} withRoot />);
    expect(created[0].options.root).toBeInstanceOf(HTMLDivElement);
    expect(created[0].options.rootMargin).toBe('0px 0px 600px 0px');
  });

  it('uses the viewport when no root is given', () => {
    render(<Harness enabled onReach={() => {}} />);
    expect(created[0].options.root).toBeNull();
    expect(created[0].options.rootMargin).toBe(`0px 0px ${Math.round(window.innerHeight * 1.5)}px 0px`);
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
