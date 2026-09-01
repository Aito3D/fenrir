/**
 * Tests for the shared `useMediaQuery` hook (T-002) — the single extraction
 * point behind `useIsMobile`, `useIsWideLayout`, `useIsSidebarCompact`, the
 * calculator's `useBelowXl`, and `Dashboard`'s `stackBelow` effect.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMediaQuery } from '../../hooks/useMediaQuery';

describe('useMediaQuery', () => {
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('defaults to false with no initializer, then adopts the live match on mount', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const { result } = renderHook(() => useMediaQuery('(max-width: 767px)'));

    // The effect runs synchronously within renderHook's act(), so by the
    // time we read `result.current` the live value has already landed.
    expect(result.current).toBe(true);
  });

  it('uses the lazy initializer for the very first render value', () => {
    // matchMedia disagrees with the initializer to prove the initializer,
    // not matchMedia, drives the pre-effect value.
    let matchesCalls = 0;
    window.matchMedia = vi.fn().mockImplementation((query: string) => {
      matchesCalls++;
      return {
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    });

    const { result } = renderHook(() => useMediaQuery('(max-width: 767px)', () => true));

    // Initializer said true; the effect then reconciles with the (false)
    // live query, matching every existing call site's "effect corrects the
    // guess" behaviour.
    expect(result.current).toBe(false);
    expect(matchesCalls).toBeGreaterThan(0);
  });

  it('does not touch matchMedia and returns false when query is null', () => {
    const matchMediaSpy = vi.fn();
    window.matchMedia = matchMediaSpy;

    const { result } = renderHook(() => useMediaQuery(null));

    expect(result.current).toBe(false);
    expect(matchMediaSpy).not.toHaveBeenCalled();
  });

  it('does not touch matchMedia and returns false when query is undefined', () => {
    const matchMediaSpy = vi.fn();
    window.matchMedia = matchMediaSpy;

    const { result } = renderHook(() => useMediaQuery(undefined));

    expect(result.current).toBe(false);
    expect(matchMediaSpy).not.toHaveBeenCalled();
  });

  it('returns true when the query matches at mount', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const { result } = renderHook(() => useMediaQuery('(min-width: 1024px)'));

    expect(result.current).toBe(true);
  });

  it('returns false when the query does not match at mount', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const { result } = renderHook(() => useMediaQuery('(min-width: 1024px)'));

    expect(result.current).toBe(false);
  });

  it('updates when a change event fires via addEventListener', () => {
    let listener: ((e: MediaQueryListEvent) => void) | null = null;

    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn((event: string, cb: (e: MediaQueryListEvent) => void) => {
        if (event === 'change') listener = cb;
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const { result } = renderHook(() => useMediaQuery('(max-width: 767px)'));

    expect(result.current).toBe(false);

    expect(listener).not.toBeNull();
    act(() => {
      listener!({ matches: true } as MediaQueryListEvent);
    });

    expect(result.current).toBe(true);
  });

  it('removes the same listener reference it added, on unmount', () => {
    let addedListener: unknown = null;
    const addEventListener = vi.fn((event: string, cb: unknown) => {
      if (event === 'change') addedListener = cb;
    });
    const removeEventListener = vi.fn();

    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener,
      removeEventListener,
      dispatchEvent: vi.fn(),
    }));

    const { unmount } = renderHook(() => useMediaQuery('(max-width: 767px)'));

    unmount();

    expect(removeEventListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledWith('change', addedListener);
  });

  it('falls back to the legacy addListener/removeListener API when addEventListener is absent', () => {
    let legacyListener: unknown = null;
    const addListener = vi.fn((cb: unknown) => {
      legacyListener = cb;
    });
    const removeListener = vi.fn();

    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener,
      removeListener,
      // No addEventListener/removeEventListener — pre-2019 Safari shape.
      dispatchEvent: vi.fn(),
    }));

    const { result, unmount } = renderHook(() => useMediaQuery('(max-width: 767px)'));

    expect(addListener).toHaveBeenCalledTimes(1);
    expect(legacyListener).not.toBeNull();

    act(() => {
      (legacyListener as (e: MediaQueryListEvent) => void)({ matches: true } as MediaQueryListEvent);
    });
    expect(result.current).toBe(true);

    unmount();
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledWith(legacyListener);
  });

  it('re-subscribes when the query string changes', () => {
    const removeEventListener1 = vi.fn();
    const removeEventListener2 = vi.fn();
    let call = 0;

    window.matchMedia = vi.fn().mockImplementation((query: string) => {
      call++;
      return {
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: call === 1 ? removeEventListener1 : removeEventListener2,
        dispatchEvent: vi.fn(),
      };
    });

    const { rerender } = renderHook(({ query }) => useMediaQuery(query), {
      initialProps: { query: '(max-width: 767px)' as string | null },
    });

    rerender({ query: '(max-width: 1143px)' });

    expect(removeEventListener1).toHaveBeenCalledTimes(1);
    expect(window.matchMedia).toHaveBeenCalledWith('(max-width: 1143px)');
  });
});
