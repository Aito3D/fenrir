import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSettledValue } from '../../hooks/useSettledValue';

describe('useSettledValue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns the initial value immediately', () => {
    const { result } = renderHook(() => useSettledValue('a', 300));
    expect(result.current).toBe('a');
  });

  it('keeps the old value until the delay elapses, then flips to the new one', () => {
    const { result, rerender } = renderHook(({ value, delay }) => useSettledValue(value, delay), {
      initialProps: { value: 'a', delay: 300 },
    });
    rerender({ value: 'b', delay: 300 });
    expect(result.current).toBe('a');
    act(() => void vi.advanceTimersByTime(299));
    expect(result.current).toBe('a');
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe('b');
  });

  it('restarts the timer on a second change before the delay elapses, never settling on the intermediate value', () => {
    const { result, rerender } = renderHook(({ value, delay }) => useSettledValue(value, delay), {
      initialProps: { value: 'a', delay: 300 },
    });
    const seen: string[] = [result.current];

    rerender({ value: 'b', delay: 300 });
    seen.push(result.current);

    act(() => void vi.advanceTimersByTime(200));
    seen.push(result.current);

    // Changes again before the first timeout (100ms remaining) would fire.
    rerender({ value: 'c', delay: 300 });
    seen.push(result.current);

    // Advancing just past the original deadline must not settle: the timer was restarted.
    act(() => void vi.advanceTimersByTime(101));
    seen.push(result.current);
    expect(result.current).toBe('a');

    // The remaining time from the second change (300 - 101 = 199ms) elapses.
    act(() => void vi.advanceTimersByTime(199));
    seen.push(result.current);
    expect(result.current).toBe('c');

    expect(seen).not.toContain('b');
  });

  it('restarts the timer when only the delay changes', () => {
    const { result, rerender } = renderHook(({ value, delay }) => useSettledValue(value, delay), {
      initialProps: { value: 'a', delay: 300 },
    });
    rerender({ value: 'b', delay: 300 });
    act(() => void vi.advanceTimersByTime(200));
    expect(result.current).toBe('a');

    // Same value, but a new delay restarts the effect's timer from 0.
    rerender({ value: 'b', delay: 500 });
    act(() => void vi.advanceTimersByTime(400));
    expect(result.current).toBe('a');
    act(() => void vi.advanceTimersByTime(100));
    expect(result.current).toBe('b');
  });

  it('clears the pending timer on unmount', () => {
    const { rerender, unmount } = renderHook(({ value, delay }) => useSettledValue(value, delay), {
      initialProps: { value: 'a', delay: 300 },
    });
    rerender({ value: 'b', delay: 300 });
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
