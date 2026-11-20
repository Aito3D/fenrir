import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useScan } from '../../../components/orders/useScan';

// jsdom stamps timeStamp from real time; fake timers move performance.now, which is what Event.timeStamp reads.
function key(k: string, target: EventTarget = document.body) {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

async function type(text: string, gap: number) {
  for (const ch of text) {
    key(ch);
    await vi.advanceTimersByTimeAsync(gap);
  }
}

describe('useScan', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    vi.advanceTimersByTime(1000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onCode with a fast burst and prevents the Enter default', async () => {
    const onCode = vi.fn();
    renderHook(() => useScan(true, onCode));
    await type('ABCD', 10);
    const enter = key('Enter');
    expect(onCode).toHaveBeenCalledTimes(1);
    expect(onCode).toHaveBeenCalledWith('ABCD');
    expect(enter.defaultPrevented).toBe(true);
  });

  it('ignores a burst shorter than 4 characters and leaves Enter alone', async () => {
    const onCode = vi.fn();
    renderHook(() => useScan(true, onCode));
    await type('ABC', 10);
    const enter = key('Enter');
    expect(onCode).not.toHaveBeenCalled();
    expect(enter.defaultPrevented).toBe(false);
  });

  it('resets the buffer when keys are more than 100 ms apart', async () => {
    const onCode = vi.fn();
    renderHook(() => useScan(true, onCode));
    await type('ABCD', 150);
    key('Enter');
    expect(onCode).not.toHaveBeenCalled();
  });

  it('drops the slow prefix and keeps the fast tail', async () => {
    const onCode = vi.fn();
    renderHook(() => useScan(true, onCode));
    await type('XY', 150);
    await type('1234', 10);
    key('Enter');
    expect(onCode).toHaveBeenCalledWith('1234');
  });

  it('clears the buffer after Enter', async () => {
    const onCode = vi.fn();
    renderHook(() => useScan(true, onCode));
    await type('ABCD', 10);
    key('Enter');
    await type('EF', 10);
    key('Enter');
    expect(onCode).toHaveBeenCalledTimes(1);
  });

  it('ignores non-printable keys', async () => {
    const onCode = vi.fn();
    renderHook(() => useScan(true, onCode));
    await type('AB', 10);
    key('Shift');
    await type('CD', 10);
    key('Enter');
    expect(onCode).toHaveBeenCalledWith('ABCD');
  });

  it('ignores keys typed into an input, a textarea or a contenteditable', async () => {
    const onCode = vi.fn();
    renderHook(() => useScan(true, onCode));
    const input = document.body.appendChild(document.createElement('input'));
    const area = document.body.appendChild(document.createElement('textarea'));
    const div = document.body.appendChild(document.createElement('div'));
    // jsdom does not implement isContentEditable
    Object.defineProperty(div, 'isContentEditable', { value: true });
    for (const el of [input, area, div]) {
      for (const ch of 'ABCD') key(ch, el);
      const enter = key('Enter', el);
      expect(enter.defaultPrevented).toBe(false);
    }
    expect(onCode).not.toHaveBeenCalled();
    input.remove();
    area.remove();
    div.remove();
  });

  it('does nothing while inactive', async () => {
    const onCode = vi.fn();
    renderHook(() => useScan(false, onCode));
    await type('ABCD', 10);
    key('Enter');
    expect(onCode).not.toHaveBeenCalled();
  });

  it('calls the latest callback without re-subscribing', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }) => useScan(true, cb), { initialProps: { cb: first } });
    rerender({ cb: second });
    await type('ABCD', 10);
    key('Enter');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('ABCD');
  });

  it('removes the listener on unmount', async () => {
    const onCode = vi.fn();
    const { unmount } = renderHook(() => useScan(true, onCode));
    unmount();
    await type('ABCD', 10);
    key('Enter');
    expect(onCode).not.toHaveBeenCalled();
  });
});
