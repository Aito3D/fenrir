import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAfterFirstPaint } from '../../hooks/useAfterFirstPaint';

/** Non-critical shell queries (update check, external links, smart plugs…)
 *  wait for this so the page's own data calls are not queued behind them.
 *  Safari has no `requestIdleCallback`; a short timer stands in. */
describe('useAfterFirstPaint', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('is false on first render and true after the fallback timer (no requestIdleCallback)', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useAfterFirstPaint());
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });

  it('uses requestIdleCallback with a timeout when the browser has it', () => {
    let idle: (() => void) | null = null;
    const ric = vi.fn((cb: () => void, opts?: { timeout?: number }) => {
      idle = cb;
      expect(opts?.timeout).toBe(1500);
      return 1;
    });
    const cancel = vi.fn();
    vi.stubGlobal('requestIdleCallback', ric);
    vi.stubGlobal('cancelIdleCallback', cancel);
    const { result, unmount } = renderHook(() => useAfterFirstPaint());
    expect(result.current).toBe(false);
    act(() => {
      idle!();
    });
    expect(result.current).toBe(true);
    unmount();
    expect(cancel).toHaveBeenCalledWith(1);
  });
});
