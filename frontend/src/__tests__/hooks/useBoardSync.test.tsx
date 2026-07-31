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
});
