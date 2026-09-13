/**
 * Tests for useCombinedGridStats — the merge-interval logic that combines
 * MJPEG grid-stream stats with per-card WebRTC stats into one subscribable
 * snapshot.
 *
 * The only other consumer (CameraGrid.test.tsx) fully mocks this hook out,
 * so its real merge-interval body (freshness filtering, bandwidth summation,
 * uptime fallback, stale-registry pruning, suspend gating) is exercised here
 * instead, driven with vi.useFakeTimers() so nothing depends on wall-clock
 * time (verified against frontend/src/hooks/useCombinedGridStats.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCombinedGridStats } from '../../hooks/useCombinedGridStats';
import type { GridStreamStats } from '../../hooks/useGridStream';
import { formatUptime } from '../../utils/date';
import { formatFileSize } from '../../utils/file';

// Matches the private WEBRTC_STATS_FRESHNESS_MS constant in the hook — not
// exported (see SURFACE.md), so pinned here as a literal.
const WEBRTC_STATS_FRESHNESS_MS = 3000;

const EMPTY_STATS: GridStreamStats = { bw: '', active: 0, total: 0, uptime: '', rawBytesPerSecond: 0, droppedFrames: 0 };

function makeMjpegStats(overrides: Partial<GridStreamStats> = {}): GridStreamStats {
  return { ...EMPTY_STATS, ...overrides };
}

interface Props {
  getMjpegStatsSnapshot: () => GridStreamStats;
  mjpegCount: number;
  webrtcCount: number;
  webrtcPrinterIdsKey: string;
  suspended: boolean;
}

function renderCombinedStats(initialProps: Props) {
  return renderHook((props: Props) => useCombinedGridStats(props), { initialProps });
}

describe('useCombinedGridStats', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sums MJPEG rawBytesPerSecond with fresh WebRTC entries reported via handleWebRTCStats', () => {
    const mjpeg = makeMjpegStats({ active: 2, total: 2, uptime: '01:00', rawBytesPerSecond: 1000 });
    const getMjpegStatsSnapshot = vi.fn(() => mjpeg);

    const { result } = renderCombinedStats({
      getMjpegStatsSnapshot,
      mjpegCount: 2,
      webrtcCount: 1,
      webrtcPrinterIdsKey: '5',
      suspended: false,
    });

    act(() => {
      result.current.handleWebRTCStats(5, { bytesPerSecond: 500, timestamp: performance.now() });
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    const snapshot = result.current.getStatsSnapshot();
    expect(snapshot.rawBytesPerSecond).toBe(1500);
    expect(snapshot.active).toBe(3); // 2 MJPEG + 1 fresh WebRTC
    expect(snapshot.total).toBe(3); // mjpegCount + webrtcCount
    expect(snapshot.bw).toBe(`${formatFileSize(1500)}/s`);
    expect(snapshot.uptime).toBe(mjpeg.uptime); // MJPEG uptime preferred when it has a stream
    expect(snapshot.droppedFrames).toBe(mjpeg.droppedFrames);
  });

  it('excludes a WebRTC entry older than WEBRTC_STATS_FRESHNESS_MS from active count and total bytes', () => {
    const getMjpegStatsSnapshot = vi.fn(() => EMPTY_STATS);

    const { result } = renderCombinedStats({
      getMjpegStatsSnapshot,
      mjpegCount: 0,
      webrtcCount: 1,
      webrtcPrinterIdsKey: '7',
      suspended: false,
    });

    act(() => {
      result.current.handleWebRTCStats(7, { bytesPerSecond: 800, timestamp: performance.now() });
    });

    // t=1000ms — entry is 1000ms old, well within the freshness window.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    let snapshot = result.current.getStatsSnapshot();
    expect(snapshot.active).toBe(1);
    expect(snapshot.rawBytesPerSecond).toBe(800);

    // t=WEBRTC_STATS_FRESHNESS_MS — the entry's age now equals the freshness
    // cutoff, which the hook excludes with a strict `<` comparison.
    act(() => {
      vi.advanceTimersByTime(WEBRTC_STATS_FRESHNESS_MS - 1000);
    });
    snapshot = result.current.getStatsSnapshot();
    expect(snapshot.active).toBe(0);
    expect(snapshot.rawBytesPerSecond).toBe(0);
    // `total` still reflects the raw prop counts, unaffected by staleness.
    expect(snapshot.total).toBe(1);
  });

  it('prunes a stale registry entry when webrtcPrinterIdsKey no longer contains its id', () => {
    const getMjpegStatsSnapshot = vi.fn(() => EMPTY_STATS);

    const { result, rerender } = renderCombinedStats({
      getMjpegStatsSnapshot,
      mjpegCount: 0,
      webrtcCount: 1,
      webrtcPrinterIdsKey: '9',
      suspended: false,
    });

    act(() => {
      result.current.handleWebRTCStats(9, { bytesPerSecond: 300, timestamp: performance.now() });
    });

    // Still within the freshness window and the key still contains '9' — counted.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.getStatsSnapshot().active).toBe(1);
    expect(result.current.getStatsSnapshot().rawBytesPerSecond).toBe(300);

    // Drop '9' from the key (webrtcCount is left at 1 so this isolates the
    // pruning effect from the count-based `total`/`hasWebrtc` math).
    rerender({
      getMjpegStatsSnapshot,
      mjpegCount: 0,
      webrtcCount: 1,
      webrtcPrinterIdsKey: '',
      suspended: false,
    });

    // t=2000ms — the entry would still be "fresh" (2000ms < 3000ms) if it
    // were still in the registry, so this proves it was pruned outright
    // rather than merely aging out.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    const snapshot = result.current.getStatsSnapshot();
    expect(snapshot.active).toBe(0);
    expect(snapshot.rawBytesPerSecond).toBe(0);
  });

  it('falls back to a WebRTC-computed uptime (via formatUptime) when mjpegCount is 0 but webrtcCount > 0', () => {
    const getMjpegStatsSnapshot = vi.fn(() => EMPTY_STATS);

    // Nudge the fake clock off exactly 0 first — webrtcStartRef is stamped
    // with performance.now() on mount, and the hook's `webrtcStartRef.current
    // > 0` guard would treat a 0 timestamp as "never started" forever.
    act(() => {
      vi.advanceTimersByTime(1);
    });

    const { result } = renderCombinedStats({
      getMjpegStatsSnapshot,
      mjpegCount: 0,
      webrtcCount: 1,
      webrtcPrinterIdsKey: '3',
      suspended: false,
    });
    const mountedAt = performance.now();

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    // webrtcStartRef is stamped at mount; after 5000ms of merge ticks the
    // elapsed WebRTC-only uptime is 5 seconds.
    const expectedSeconds = Math.floor((performance.now() - mountedAt) / 1000);
    expect(result.current.getStatsSnapshot().uptime).toBe(formatUptime(expectedSeconds));
  });

  it('does not push an update to subscribers while suspended is true', () => {
    const getMjpegStatsSnapshot = vi.fn(() => EMPTY_STATS);
    const subscriber = vi.fn();

    const { result, rerender } = renderCombinedStats({
      getMjpegStatsSnapshot,
      mjpegCount: 1,
      webrtcCount: 0,
      webrtcPrinterIdsKey: '',
      suspended: true,
    });

    act(() => {
      result.current.subscribeStats(subscriber);
    });

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(subscriber).not.toHaveBeenCalled();
    // The combined snapshot itself was never written while suspended.
    expect(result.current.getStatsSnapshot()).toEqual(EMPTY_STATS);

    rerender({
      getMjpegStatsSnapshot,
      mjpegCount: 1,
      webrtcCount: 0,
      webrtcPrinterIdsKey: '',
      suspended: false,
    });

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(subscriber).toHaveBeenCalled();
  });
});
