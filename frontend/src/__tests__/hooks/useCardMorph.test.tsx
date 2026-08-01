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

  it('leaves the card alone when closing with toCard: false, and scopes the exit', () => {
    let scopeDuringCallback: string | undefined;
    document.startViewTransition = vi.fn((cb: () => void) => {
      cb();
      // Read inside the callback: this is the state the browser resolves the
      // pseudo-element styles against.
      scopeDuringCallback = document.documentElement.dataset.vt;
      return { finished: new Promise(() => {}), ready: Promise.resolve(), updateCallbackDone: Promise.resolve() };
    }) as unknown as typeof document.startViewTransition;

    const setExpandedId = vi.fn();
    const { result } = renderHook(() => useCardMorph(setExpandedId));
    act(() => result.current.close(12, { toCard: false }));

    expect(setExpandedId).toHaveBeenCalledWith(null);
    // A flight is about to carry this card across the board. Handing it the
    // shared name would morph the panel onto the card's destination — the one
    // place the ghost is heading — and land there first.
    expect(card.style.viewTransitionName).toBe('');
    // No counterpart means no UA-generated group animation, so the exit scope
    // is what stops the opaque group sitting on the board as a blank slab.
    expect(scopeDuringCallback).toBe('aito-card-exit');
  });

  it('scopes the close as an exit when the card has left while the panel was closing', () => {
    let scopeDuringCallback: string | undefined;
    document.startViewTransition = vi.fn((cb: () => void) => {
      // The delete path mutates the cache in the same tick as it closes, so
      // by the time this callback runs the card is already out of the DOM.
      card.remove();
      cb();
      scopeDuringCallback = document.documentElement.dataset.vt;
      return { finished: new Promise(() => {}), ready: Promise.resolve(), updateCallbackDone: Promise.resolve() };
    }) as unknown as typeof document.startViewTransition;

    const { result } = renderHook(() => useCardMorph(vi.fn()));
    act(() => result.current.close(12));

    expect(scopeDuringCallback).toBe('aito-card-exit');
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
