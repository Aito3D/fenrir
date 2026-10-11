import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';

describe('useDebouncedValue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts at the initial value', () => {
    const { result } = renderHook(({ v }) => useDebouncedValue(v, 250), { initialProps: { v: 'abc' } });
    expect(result.current).toBe('abc');
  });

  it('updates only once the delay has elapsed', () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 250), { initialProps: { v: '' } });
    rerender({ v: 'drone' });
    expect(result.current).toBe('');
    act(() => vi.advanceTimersByTime(249));
    expect(result.current).toBe('');
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe('drone');
  });

  it('restarts the timer on every change and keeps only the last value', () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 250), { initialProps: { v: '' } });
    rerender({ v: 'd' });
    act(() => vi.advanceTimersByTime(200));
    rerender({ v: 'dr' });
    act(() => vi.advanceTimersByTime(200));
    rerender({ v: 'dro' });
    act(() => vi.advanceTimersByTime(200));
    expect(result.current).toBe('');
    act(() => vi.advanceTimersByTime(50));
    expect(result.current).toBe('dro');
  });

  it('honours the delay it is given', () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 1000), { initialProps: { v: 1 } });
    rerender({ v: 2 });
    act(() => vi.advanceTimersByTime(999));
    expect(result.current).toBe(1);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(2);
  });

  it('cancels the pending update on unmount', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const { rerender, unmount } = renderHook(({ v }) => useDebouncedValue(v, 250), { initialProps: { v: 'a' } });
    rerender({ v: 'b' });
    expect(vi.getTimerCount()).toBe(1);
    clearSpy.mockClear();
    unmount();
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    clearSpy.mockRestore();
  });
});
