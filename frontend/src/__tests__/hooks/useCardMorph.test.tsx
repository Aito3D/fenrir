import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCardMorph, AITO_CARD_VT_NAME } from '../../hooks/useCardMorph';

let card: HTMLElement;

beforeEach(() => {
  card = document.createElement('div');
  card.setAttribute('data-aito-card-id', '12');
  card.scrollIntoView = () => {};
  document.body.appendChild(card);
});

afterEach(() => {
  card.remove();
  delete (document as { startViewTransition?: unknown }).startViewTransition;
  delete document.documentElement.dataset.vt;
});

describe('useCardMorph', () => {
  it('expands directly when the View Transitions API is unavailable', () => {
    const setExpandedId = vi.fn();
    const { result } = renderHook(() => useCardMorph(setExpandedId));
    act(() => result.current.open(12));
    expect(setExpandedId).toHaveBeenCalledWith(12);
    expect(card.style.viewTransitionName).toBe('');
  });

  it('hands the shared name from the card to the panel inside the transition', () => {
    let nameDuringCallback = '';
    const setExpandedId = vi.fn();
    document.startViewTransition = vi.fn((cb: () => void) => {
      nameDuringCallback = card.style.viewTransitionName;
      cb();
      return { finished: Promise.resolve(), ready: Promise.resolve(), updateCallbackDone: Promise.resolve() };
    }) as unknown as typeof document.startViewTransition;

    const { result } = renderHook(() => useCardMorph(setExpandedId));
    act(() => result.current.open(12));

    expect(nameDuringCallback).toBe(AITO_CARD_VT_NAME);
    expect(setExpandedId).toHaveBeenCalledWith(12);
    // Cleared again by the end of the callback so the panel can claim the name.
    expect(card.style.viewTransitionName).toBe('');
  });

  it('scopes the transition so the page-level crossfade is suppressed', () => {
    let scopeDuringCallback: string | undefined;
    document.startViewTransition = vi.fn((cb: () => void) => {
      scopeDuringCallback = document.documentElement.dataset.vt;
      cb();
      return { finished: Promise.resolve(), ready: Promise.resolve(), updateCallbackDone: Promise.resolve() };
    }) as unknown as typeof document.startViewTransition;

    const { result } = renderHook(() => useCardMorph(vi.fn()));
    act(() => result.current.open(12));
    expect(scopeDuringCallback).toBe('aito-card');
  });

  it('gives the name back to the card when closing', () => {
    document.startViewTransition = vi.fn((cb: () => void) => {
      cb();
      return { finished: new Promise(() => {}), ready: Promise.resolve(), updateCallbackDone: Promise.resolve() };
    }) as unknown as typeof document.startViewTransition;

    const setExpandedId = vi.fn();
    const { result } = renderHook(() => useCardMorph(setExpandedId));
    act(() => result.current.close(12));

    expect(setExpandedId).toHaveBeenCalledWith(null);
    expect(card.style.viewTransitionName).toBe(AITO_CARD_VT_NAME);
  });

  it('falls back to a plain expand when the card node is gone', () => {
    card.remove();
    const setExpandedId = vi.fn();
    document.startViewTransition = vi.fn() as unknown as typeof document.startViewTransition;
    const { result } = renderHook(() => useCardMorph(setExpandedId));
    act(() => result.current.open(12));
    expect(setExpandedId).toHaveBeenCalledWith(12);
    expect(document.startViewTransition).not.toHaveBeenCalled();
  });
});
