/** The projects dialogs' deferred close: requestClose flips `closing` at once and fires the
 *  caller's onClose after the exit beat, by timer (never animationend); the latest onClose
 *  wins; an unmount mid-exit cancels it. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { DIALOG_EXIT_MS, useDialogExit } from '../../../components/projects/useDialogExit';

afterEach(() => {
  vi.useRealTimers();
});

describe('useDialogExit', () => {
  it('starts open, flips closing at once and calls onClose only after the exit beat', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { result } = renderHook(() => useDialogExit(onClose));
    expect(result.current.closing).toBe(false);
    act(() => result.current.requestClose());
    expect(result.current.closing).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(DIALOG_EXIT_MS - 1); });
    expect(onClose).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onClose).toHaveBeenCalledTimes(1);
    // A second request while closing does not schedule a second close.
    act(() => result.current.requestClose());
    act(() => { vi.advanceTimersByTime(DIALOG_EXIT_MS); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the exit beat is the app-wide 150ms', () => {
    expect(DIALOG_EXIT_MS).toBe(150);
  });

  it('calls the onClose of the latest render, not the one the close was requested with', () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderHook(({ onClose }) => useDialogExit(onClose), { initialProps: { onClose: first } });
    act(() => result.current.requestClose());
    rerender({ onClose: second });
    act(() => { vi.advanceTimersByTime(DIALOG_EXIT_MS); });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('an unmount during the exit cancels the deferred close', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { result, unmount } = renderHook(() => useDialogExit(onClose));
    act(() => result.current.requestClose());
    unmount();
    act(() => { vi.advanceTimersByTime(DIALOG_EXIT_MS * 2); });
    expect(onClose).not.toHaveBeenCalled();
  });
});
