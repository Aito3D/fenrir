import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  registerPresenceSender,
  sendAitoPresence,
  setAitoPresenceState,
  useAitoViewers,
  __resetAitoPresence,
} from '../../hooks/useAitoPresence';

describe('useAitoPresence', () => {
  beforeEach(() => __resetAitoPresence());

  it('exposes the viewers for one project and re-renders on updates', () => {
    const { result } = renderHook(() => useAitoViewers(3));
    expect(result.current).toEqual([]);
    act(() => setAitoPresenceState({ '3': ['marie'], '9': ['jo'] }));
    expect(result.current).toEqual(['marie']);
  });

  it('sends through a registered sender and replays own presence on reconnect', () => {
    const send = vi.fn();
    registerPresenceSender(send);
    sendAitoPresence(7);
    expect(send).toHaveBeenCalledWith({ type: 'aito_presence', project_id: 7 });

    registerPresenceSender(null); // socket dropped
    const send2 = vi.fn();
    registerPresenceSender(send2); // reconnected — own presence replays
    expect(send2).toHaveBeenCalledWith({ type: 'aito_presence', project_id: 7 });
  });

  it('does not replay a cleared presence', () => {
    sendAitoPresence(null);
    const send = vi.fn();
    registerPresenceSender(send);
    expect(send).not.toHaveBeenCalled();
  });
});
