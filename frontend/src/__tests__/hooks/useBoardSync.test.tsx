import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { useBoardSync, __resetBoardSync } from '../../hooks/useBoardSync';

describe('useBoardSync', () => {
  beforeEach(() => __resetBoardSync());

  it('invalidates only when the last in-flight write settles', () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockImplementation(() => Promise.resolve());
    const { result } = renderHook(() => useBoardSync());

    act(() => {
      result.current.begin();
      result.current.begin();
    });
    act(() => result.current.settle(client));
    expect(invalidate).not.toHaveBeenCalled();

    act(() => result.current.settle(client));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['aito-projects'] });
  });

  it('bumps the generation on every settle, not just the last', () => {
    const client = new QueryClient();
    vi.spyOn(client, 'invalidateQueries').mockImplementation(() => Promise.resolve());
    const { result } = renderHook(() => useBoardSync());
    const first = result.current.generation;

    act(() => {
      result.current.begin();
      result.current.begin();
    });
    act(() => result.current.settle(client));
    expect(result.current.generation).not.toBe(first);
  });

  it('resyncIfIdle does nothing while a write is in flight', () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockImplementation(() => Promise.resolve());
    const { result } = renderHook(() => useBoardSync());

    act(() => result.current.begin());
    act(() => result.current.resyncIfIdle(client));
    expect(invalidate).not.toHaveBeenCalled();

    act(() => result.current.settle(client));
    invalidate.mockClear();
    act(() => result.current.resyncIfIdle(client));
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it('shares the count across separate hook instances', () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockImplementation(() => Promise.resolve());
    const a = renderHook(() => useBoardSync());
    const b = renderHook(() => useBoardSync());

    act(() => a.result.current.begin());
    act(() => b.result.current.settle(client));
    expect(invalidate).toHaveBeenCalledOnce();
  });

  // `dragMoves`/`isDragIdle` is the OTHER half of the counter split whose
  // conflation into one shared counter was the critical bug this module's
  // own doc walks through: every non-drag write used to freeze
  // useBoardDrag's local-board rebuild too, even though only a drag has
  // local state worth protecting. Regression coverage for `pendingWrites`
  // existed; this half had none.
  describe('dragMoves / isDragIdle', () => {
    it('starts idle', () => {
      const { result } = renderHook(() => useBoardSync());
      expect(result.current.isDragIdle()).toBe(true);
    });

    it('goes non-idle after beginMove and back to idle after settleMove', () => {
      const { result } = renderHook(() => useBoardSync());

      act(() => result.current.beginMove());
      expect(result.current.isDragIdle()).toBe(false);

      act(() => result.current.settleMove());
      expect(result.current.isDragIdle()).toBe(true);
    });

    it('stays non-idle until every beginMove has a matching settleMove', () => {
      const { result } = renderHook(() => useBoardSync());

      act(() => {
        result.current.beginMove();
        result.current.beginMove();
      });
      act(() => result.current.settleMove());
      expect(result.current.isDragIdle()).toBe(false);

      act(() => result.current.settleMove());
      expect(result.current.isDragIdle()).toBe(true);
    });

    it('clamps at zero: an extra settleMove with no matching beginMove does not go negative', () => {
      const { result } = renderHook(() => useBoardSync());

      act(() => result.current.settleMove());
      expect(result.current.isDragIdle()).toBe(true);

      // If this had gone negative, one real beginMove/settleMove pair right
      // after would leave the counter still non-zero (still "dragging")
      // instead of returning to idle.
      act(() => result.current.beginMove());
      act(() => result.current.settleMove());
      expect(result.current.isDragIdle()).toBe(true);
    });

    it('is independent of pendingWrites in both directions', () => {
      const client = new QueryClient();
      vi.spyOn(client, 'invalidateQueries').mockImplementation(() => Promise.resolve());
      const { result } = renderHook(() => useBoardSync());

      // A non-drag write (begin/settle) must never freeze drag's local-board
      // rebuild — that conflation is exactly the bug this split fixed.
      act(() => result.current.begin());
      expect(result.current.isDragIdle()).toBe(true);
      act(() => result.current.settle(client));
      expect(result.current.isDragIdle()).toBe(true);

      // Symmetrically, a drag move must never block the settle-invalidate
      // arbitration other writers rely on.
      act(() => result.current.beginMove());
      expect(result.current.isIdle()).toBe(true);
      act(() => result.current.settleMove());
      expect(result.current.isIdle()).toBe(true);
    });

    it('shares the count across separate hook instances, like pendingWrites does', () => {
      const a = renderHook(() => useBoardSync());
      const b = renderHook(() => useBoardSync());

      act(() => a.result.current.beginMove());
      expect(b.result.current.isDragIdle()).toBe(false);

      act(() => b.result.current.settleMove());
      expect(a.result.current.isDragIdle()).toBe(true);
    });
  });
});
