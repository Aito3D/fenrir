import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { flashRevert, useIsReverting } from '../../hooks/useRevertFlash';

describe('useRevertFlash', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('marks the flashed id and clears it after 600ms', () => {
    const { result } = renderHook(() => useIsReverting(7));
    expect(result.current).toBe(false);

    act(() => flashRevert(7));
    expect(result.current).toBe(true);

    act(() => vi.advanceTimersByTime(600));
    expect(result.current).toBe(false);
  });

  it('does not mark a different id', () => {
    const { result } = renderHook(() => useIsReverting(1));
    act(() => flashRevert(2));
    expect(result.current).toBe(false);
  });

  it('a second flash restarts the window rather than stacking timers', () => {
    const { result } = renderHook(() => useIsReverting(3));
    act(() => flashRevert(3));
    act(() => vi.advanceTimersByTime(400));
    act(() => flashRevert(3));
    act(() => vi.advanceTimersByTime(400));
    // Still inside the restarted window.
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(200));
    expect(result.current).toBe(false);
  });
});
