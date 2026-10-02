/**
 * Tests for the useStreamReconnect hook.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useStreamReconnect } from '../../hooks/useStreamReconnect';

describe('useStreamReconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(overrides: Partial<Parameters<typeof useStreamReconnect>[0]> = {}) {
    const onReconnect = vi.fn();
    const onGiveUp = vi.fn();
    return renderHook(() =>
      useStreamReconnect({
        maxAttempts: 3,
        initialDelay: 1000,
        maxDelay: 8000,
        onReconnect,
        onGiveUp,
        ...overrides,
      })
    );
  }

  describe('initial state', () => {
    it('starts with zero reconnect attempts', () => {
      const { result } = setup();
      expect(result.current.reconnectAttempts).toBe(0);
    });

    it('starts not reconnecting', () => {
      const { result } = setup();
      expect(result.current.isReconnecting).toBe(false);
    });

    it('starts with zero countdown', () => {
      const { result } = setup();
      expect(result.current.reconnectCountdown).toBe(0);
    });
  });

  describe('handleStreamSuccess', () => {
    it('resets reconnect state', () => {
      const { result } = setup();
      act(() => result.current.handleStreamSuccess());
      expect(result.current.reconnectAttempts).toBe(0);
      expect(result.current.isReconnecting).toBe(false);
    });
  });

  describe('handleStreamError', () => {
    it('triggers initial fast retry before first success', () => {
      const onReconnect = vi.fn();
      const { result } = setup({ onReconnect, initialRetryDelay: 500, initialRetryMax: 3 });

      act(() => result.current.handleStreamError());

      // Should schedule a fast retry, not visible reconnecting
      expect(result.current.isReconnecting).toBe(false);

      // Fast forward past initialRetryDelay
      act(() => { vi.advanceTimersByTime(600); });
      expect(onReconnect).toHaveBeenCalledTimes(1);
    });

    it('calls onGiveUp after exhausting initial retries without success', () => {
      const onGiveUp = vi.fn();
      const onReconnect = vi.fn();
      const { result } = setup({ onReconnect, onGiveUp, initialRetryDelay: 100, initialRetryMax: 2 });

      // Exhaust initial retries
      for (let i = 0; i < 2; i++) {
        act(() => result.current.handleStreamError());
        act(() => { vi.advanceTimersByTime(200); });
      }

      // Third error should give up
      act(() => result.current.handleStreamError());
      expect(onGiveUp).toHaveBeenCalled();
    });

    it('uses exponential backoff after first connection', () => {
      const onReconnect = vi.fn();
      const { result } = setup({ onReconnect, initialDelay: 1000, maxDelay: 8000 });

      // Simulate first successful connection
      act(() => result.current.handleStreamSuccess());

      // Now trigger error — should enter reconnecting
      act(() => result.current.handleStreamError());
      expect(result.current.isReconnecting).toBe(true);
      expect(result.current.reconnectCountdown).toBe(1); // ceil(1000/1000)

      // Advance past first delay
      act(() => { vi.advanceTimersByTime(1100); });
      expect(onReconnect).toHaveBeenCalledTimes(1);
      expect(result.current.reconnectAttempts).toBe(1);
    });
  });

  describe('reset', () => {
    it('clears all reconnect state', () => {
      const onReconnect = vi.fn();
      const { result } = setup({ onReconnect });

      // Get into reconnecting state
      act(() => result.current.handleStreamSuccess());
      act(() => result.current.handleStreamError());
      expect(result.current.isReconnecting).toBe(true);

      act(() => result.current.reset());
      expect(result.current.reconnectAttempts).toBe(0);
      expect(result.current.isReconnecting).toBe(false);
      expect(result.current.reconnectCountdown).toBe(0);
    });
  });

  describe('pending reconnect timer (T-018)', () => {
    it('cancels the first pending reconnect when a second trigger arrives, firing onReconnect exactly once', () => {
      const onReconnect = vi.fn();
      const { result } = setup({ onReconnect, initialDelay: 1000, maxDelay: 8000 });

      // First successful connection, then two error triggers within the same delay window
      // (e.g. the stall interval and the MJPEG onError path both firing close together).
      act(() => result.current.handleStreamSuccess());
      act(() => result.current.handleStreamError());
      expect(result.current.isReconnecting).toBe(true);
      expect(result.current.reconnectCountdown).toBe(1); // ceil(1000/1000)

      act(() => { vi.advanceTimersByTime(400); });
      act(() => result.current.handleStreamError());
      // Second trigger re-arms with the same backoff (attempt count hasn't advanced yet)
      // and restarts the countdown — this is what the user already observes today.
      expect(result.current.isReconnecting).toBe(true);
      expect(result.current.reconnectCountdown).toBe(1);

      // Advance past what would have been the FIRST timer's fire time. Only the
      // second (most recent) trigger should be armed, so nothing should fire yet.
      act(() => { vi.advanceTimersByTime(700); }); // total 1100ms since first trigger
      expect(onReconnect).not.toHaveBeenCalled();

      // Advance past the second timer's fire time (armed at t=400, delay 1000 -> fires at t=1400)
      act(() => { vi.advanceTimersByTime(400); }); // total 1500ms since first trigger
      expect(onReconnect).toHaveBeenCalledTimes(1);
      expect(result.current.reconnectAttempts).toBe(1);
    });

    it('never fires onReconnect if reset() happens before the (re-armed) pending reconnect delay elapses', () => {
      const onReconnect = vi.fn();
      const { result } = setup({ onReconnect, initialDelay: 1000, maxDelay: 8000 });

      act(() => result.current.handleStreamSuccess());
      act(() => result.current.handleStreamError());
      act(() => { vi.advanceTimersByTime(400); });
      act(() => result.current.handleStreamError());

      act(() => result.current.reset());

      // Advance well past both the original and the re-armed timer's fire times.
      act(() => { vi.advanceTimersByTime(3000); });
      expect(onReconnect).not.toHaveBeenCalled();
    });

    it('never fires onReconnect if the component unmounts before the (re-armed) pending reconnect delay elapses', () => {
      const onReconnect = vi.fn();
      const { result, unmount } = setup({ onReconnect, initialDelay: 1000, maxDelay: 8000 });

      act(() => result.current.handleStreamSuccess());
      act(() => result.current.handleStreamError());
      act(() => { vi.advanceTimersByTime(400); });
      act(() => result.current.handleStreamError());

      unmount();

      // Advance well past both the original and the re-armed timer's fire times.
      act(() => { vi.advanceTimersByTime(3000); });
      expect(onReconnect).not.toHaveBeenCalled();
    });

    it('schedules a fresh reconnect normally after a pending one has already fired', () => {
      const onReconnect = vi.fn();
      const { result } = setup({ onReconnect, initialDelay: 1000, maxDelay: 8000 });

      act(() => result.current.handleStreamSuccess());
      act(() => result.current.handleStreamError());
      act(() => { vi.advanceTimersByTime(1100); });
      expect(onReconnect).toHaveBeenCalledTimes(1);
      expect(result.current.reconnectAttempts).toBe(1);

      // A later trigger (after the pending one fired) should schedule normally,
      // using the next backoff step.
      act(() => result.current.handleStreamError());
      expect(result.current.isReconnecting).toBe(true);
      act(() => { vi.advanceTimersByTime(2100); }); // 1000 * 2^1 = 2000
      expect(onReconnect).toHaveBeenCalledTimes(2);
      expect(result.current.reconnectAttempts).toBe(2);
    });
  });

  describe('stall detection', () => {
    const tick = (ms = 1000) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

    it('does not reconnect after a single stalled read', async () => {
      const onReconnect = vi.fn();
      const checkStalled = vi.fn().mockResolvedValue(true);
      const { result } = setup({ onReconnect, checkStalled, stallCheckInterval: 1000 });

      await tick();
      expect(checkStalled).toHaveBeenCalledTimes(1);
      expect(result.current.isReconnecting).toBe(false);

      await tick(500);
      expect(onReconnect).not.toHaveBeenCalled();
    });

    it('starts a reconnect after two consecutive stalled reads and stops polling', async () => {
      const onReconnect = vi.fn();
      const checkStalled = vi.fn().mockResolvedValue(true);
      const { result } = setup({ onReconnect, checkStalled, stallCheckInterval: 1000, initialDelay: 1000 });

      await tick();
      await tick();
      expect(checkStalled).toHaveBeenCalledTimes(2);
      expect(result.current.isReconnecting).toBe(true);
      expect(result.current.reconnectCountdown).toBe(1);

      // Interval is torn down while reconnecting: no further stall reads.
      await tick(500);
      expect(checkStalled).toHaveBeenCalledTimes(2);

      await tick(600);
      expect(onReconnect).toHaveBeenCalledTimes(1);
      expect(result.current.reconnectAttempts).toBe(1);
      expect(result.current.isReconnecting).toBe(false);
    });

    it('resets the strike counter when a read is not stalled', async () => {
      const onReconnect = vi.fn();
      const checkStalled = vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValue(true);
      const { result } = setup({ onReconnect, checkStalled, stallCheckInterval: 1000 });

      await tick(); // stalled (strike 1)
      await tick(); // healthy (reset)
      await tick(); // stalled (strike 1 again)
      expect(result.current.isReconnecting).toBe(false);

      await tick(); // stalled (strike 2)
      expect(result.current.isReconnecting).toBe(true);
    });

    it('ignores errors from checkStalled without clearing a strike', async () => {
      const checkStalled = vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue(true);
      const { result } = setup({ checkStalled, stallCheckInterval: 1000 });

      await tick(); // strike 1
      await tick(); // rejected, ignored
      expect(result.current.isReconnecting).toBe(false);

      await tick(); // strike 2
      expect(result.current.isReconnecting).toBe(true);
    });

    it('skips a tick while the previous stall read is still in flight', async () => {
      let resolveFirst: (v: boolean) => void = () => {};
      const checkStalled = vi
        .fn()
        .mockImplementationOnce(() => new Promise<boolean>((r) => { resolveFirst = r; }))
        .mockResolvedValue(false);
      setup({ checkStalled, stallCheckInterval: 1000 });

      await tick(3000);
      expect(checkStalled).toHaveBeenCalledTimes(1);

      await act(async () => { resolveFirst(false); });
      await tick();
      expect(checkStalled).toHaveBeenCalledTimes(2);
    });

    it('does not poll while stallPaused, and resumes polling when unpaused', async () => {
      const checkStalled = vi.fn().mockResolvedValue(false);
      const onReconnect = vi.fn();
      const { rerender } = renderHook(
        ({ paused }: { paused: boolean }) =>
          useStreamReconnect({ onReconnect, checkStalled, stallPaused: paused, stallCheckInterval: 1000 }),
        { initialProps: { paused: true } }
      );

      await tick(5000);
      expect(checkStalled).not.toHaveBeenCalled();

      rerender({ paused: false });
      await tick();
      expect(checkStalled).toHaveBeenCalledTimes(1);

      rerender({ paused: true });
      await tick(5000);
      expect(checkStalled).toHaveBeenCalledTimes(1);
    });

    it('does not poll without a checkStalled callback', async () => {
      const { result } = setup({ stallCheckInterval: 1000 });
      await tick(5000);
      expect(result.current.isReconnecting).toBe(false);
    });

    it('stops polling on unmount', async () => {
      const checkStalled = vi.fn().mockResolvedValue(false);
      const { unmount } = setup({ checkStalled, stallCheckInterval: 1000 });

      await tick();
      expect(checkStalled).toHaveBeenCalledTimes(1);

      unmount();
      await tick(5000);
      expect(checkStalled).toHaveBeenCalledTimes(1);
    });

    it('starts with fresh strikes after a reconnect completes', async () => {
      const checkStalled = vi.fn().mockResolvedValue(true);
      const { result } = setup({ checkStalled, stallCheckInterval: 1000, initialDelay: 1000 });

      await tick();
      await tick();
      expect(result.current.isReconnecting).toBe(true);
      await tick(1100);
      expect(result.current.isReconnecting).toBe(false);

      // One stalled read after the restart is not enough on its own.
      await tick();
      expect(result.current.isReconnecting).toBe(false);
      await tick();
      expect(result.current.isReconnecting).toBe(true);
    });
  });

  describe('max-attempts give-up (T-045)', () => {
    const tick = (ms = 1000) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

    it('gives up from the stall path once maxAttempts reconnects were consumed, without scheduling another', async () => {
      const onReconnect = vi.fn();
      const onGiveUp = vi.fn();
      const checkStalled = vi.fn().mockResolvedValue(true);
      const { result } = setup({
        onReconnect, onGiveUp, checkStalled, maxAttempts: 1, stallCheckInterval: 1000, initialDelay: 1000,
      });

      // First stall episode consumes the single allowed attempt.
      await tick();
      await tick();
      expect(result.current.isReconnecting).toBe(true);
      await tick(1100);
      expect(onReconnect).toHaveBeenCalledTimes(1);
      expect(result.current.reconnectAttempts).toBe(1);
      expect(onGiveUp).not.toHaveBeenCalled();

      // Second stall episode hits the max-attempts guard in attemptReconnect.
      await tick();
      await tick();
      expect(onGiveUp).toHaveBeenCalledTimes(1);
      expect(result.current.isReconnecting).toBe(false);

      // No reconnect is scheduled and the stall poll stays stopped.
      const reads = checkStalled.mock.calls.length;
      await tick(10000);
      expect(onReconnect).toHaveBeenCalledTimes(1);
      expect(onGiveUp).toHaveBeenCalledTimes(1);
      expect(checkStalled).toHaveBeenCalledTimes(reads);
    });

    it('calls onGiveUp from handleStreamError, not onReconnect, once attempts are exhausted after a connection', () => {
      const onReconnect = vi.fn();
      const onGiveUp = vi.fn();
      const { result } = setup({ onReconnect, onGiveUp, maxAttempts: 1, initialDelay: 1000 });

      act(() => result.current.handleStreamSuccess());
      act(() => result.current.handleStreamError());
      act(() => { vi.advanceTimersByTime(1100); });
      expect(onReconnect).toHaveBeenCalledTimes(1);
      expect(onGiveUp).not.toHaveBeenCalled();

      act(() => result.current.handleStreamError());
      expect(onGiveUp).toHaveBeenCalledTimes(1);
      expect(result.current.isReconnecting).toBe(false);

      act(() => { vi.advanceTimersByTime(10000); });
      expect(onReconnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('returned API', () => {
    it('returns all expected functions', () => {
      const { result } = setup();
      expect(typeof result.current.handleStreamError).toBe('function');
      expect(typeof result.current.handleStreamSuccess).toBe('function');
      expect(typeof result.current.reset).toBe('function');
      expect(typeof result.current.cleanup).toBe('function');
    });
  });
});
