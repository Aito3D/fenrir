/**
 * Toasts for other operators' board actions: never the viewer's own, never
 * an unnamed actor, only the notable actions, and a burst is one toast.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { AITO_PEER_CHANGE_EVENT, useAitoPeerToasts, type AitoPeerChange } from '../../hooks/useAitoPeerToasts';

const showToast = vi.fn();
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ showToast }) }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { username: 'paul' } }) }));

const send = (detail: AitoPeerChange) =>
  act(() => {
    window.dispatchEvent(new CustomEvent(AITO_PEER_CHANGE_EVENT, { detail }));
  });
const settle = () => act(() => vi.advanceTimersByTime(1500));

describe('useAitoPeerToasts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    showToast.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("says what another operator did, naming the column a card moved to", () => {
    renderHook(() => useAitoPeerToasts());
    send({ action: 'move', actor: 'marie', column: 'print' });
    expect(showToast).not.toHaveBeenCalled();
    settle();
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('marie moved a card to Printing & Machining', 'info');
  });

  it('stays quiet for my own action, an unnamed actor, an in-column reorder and plain edits', () => {
    renderHook(() => useAitoPeerToasts());
    send({ action: 'move', actor: 'paul', column: 'print' });
    send({ action: 'create', actor: null });
    send({ action: 'move', actor: 'marie' });
    send({ action: 'task', actor: 'marie' });
    send({ action: 'update', actor: 'marie' });
    settle();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('coalesces a burst into one toast naming everyone involved', () => {
    renderHook(() => useAitoPeerToasts());
    send({ action: 'delete', actor: 'marie' });
    send({ action: 'delete', actor: 'marie' });
    send({ action: 'create', actor: 'teva' });
    settle();
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('marie, teva made 3 changes on the board', 'info');
    // The window closed: the next change is its own toast.
    send({ action: 'restore', actor: 'marie' });
    settle();
    expect(showToast).toHaveBeenLastCalledWith('marie restored a card', 'info');
  });

  it('says nothing once the board is closed', () => {
    const { unmount } = renderHook(() => useAitoPeerToasts());
    send({ action: 'create', actor: 'marie' });
    unmount();
    settle();
    send({ action: 'create', actor: 'marie' });
    settle();
    expect(showToast).not.toHaveBeenCalled();
  });
});
