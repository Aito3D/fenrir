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
