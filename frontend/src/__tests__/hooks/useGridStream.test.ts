/**
 * Tests for useGridStream constants and types.
 *
 * The hook itself is tightly coupled to Web Workers and fetch streams,
 * making unit testing impractical without a full browser environment.
 * Worker behavior is covered by cameraGridDecoder.test.ts.
 * Reconnect logic is covered by useGridReconnect tests below.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGridReconnect } from '../../hooks/useGridReconnect';
import type { GridStreamStats } from '../../hooks/useGridStream';

describe('GridStreamStats type', () => {
  it('has the expected shape', () => {
    const stats: GridStreamStats = {
      bw: '1.2 MB/s',
      active: 3,
      total: 5,
      uptime: '02:30',
      rawBytesPerSecond: 1258291,
      droppedFrames: 0,
    };
    expect(stats.bw).toBe('1.2 MB/s');
    expect(stats.active).toBe(3);
    expect(stats.total).toBe(5);
    expect(stats.uptime).toBe('02:30');
    expect(stats.rawBytesPerSecond).toBe(1258291);
    expect(stats.droppedFrames).toBe(0);
  });
});

describe('useGridReconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with zero state', () => {
    const { result } = renderHook(() => useGridReconnect());
    expect(result.current.reconnectAttempt).toBe(0);
    expect(result.current.reconnectCountdown).toBe(0);
    expect(result.current.reconnectingSet.size).toBe(0);
  });

  it('scheduleReconnect increments attempt and sets reconnectingSet', async () => {
    const { result } = renderHook(() => useGridReconnect());

    // Start reconnect (don't await — it waits for the delay)
    let resolved = false;
    act(() => {
      result.current.scheduleReconnect([1, 2]).then(() => { resolved = true; });
    });

    expect(result.current.reconnectAttempt).toBe(1);
    expect(result.current.reconnectingSet).toEqual(new Set([1, 2]));
    expect(result.current.reconnectCountdown).toBeGreaterThan(0);

    // Advance past the delay
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(resolved).toBe(true);
  });

  it('resetReconnect clears all state', () => {
    const { result } = renderHook(() => useGridReconnect());

    act(() => {
      result.current.scheduleReconnect([1]);
    });
    expect(result.current.reconnectAttempt).toBe(1);

    act(() => {
      result.current.resetReconnect();
    });
    expect(result.current.reconnectAttempt).toBe(0);
    expect(result.current.reconnectCountdown).toBe(0);
    expect(result.current.reconnectingSet.size).toBe(0);
  });

  it('exponential backoff increases delay', async () => {
    const { result } = renderHook(() => useGridReconnect());

    // First reconnect: countdown should be ~2s (ceil(2000/1000))
    act(() => {
      result.current.scheduleReconnect([1]);
    });
    const firstCountdown = result.current.reconnectCountdown;

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    // Second reconnect: countdown should be ~4s (ceil(4000/1000))
    act(() => {
      result.current.scheduleReconnect([1]);
    });
    const secondCountdown = result.current.reconnectCountdown;

    expect(secondCountdown).toBeGreaterThan(firstCountdown);
  });
});
