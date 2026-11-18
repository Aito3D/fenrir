import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { clearNewOrderDraft, useNewOrderDraft } from '../../hooks/useNewOrderDraft';
import type { NewOrderDraft } from '../../hooks/useNewOrderDraft';

const KEY = 'orders.newOrderDraft.v1';
const item = { id: 'i1', name: 'PLA', sku: 'PLA-1', rate: 1000, stock_on_hand: 3, product_type: 'goods' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useNewOrderDraft', () => {
  it('persists and restores lines, client and clientRef', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNewOrderDraft());
    const draft: NewOrderDraft = {
      lines: [{ item, quantity: 2, discount: '10%' }],
      client: { id: 'c1', name: 'Moana', isDefault: false },
      clientRef: result.current.draft.clientRef,
    };
    act(() => result.current.setDraft(draft));
    act(() => void vi.advanceTimersByTime(500));
    const { result: second } = renderHook(() => useNewOrderDraft());
    expect(second.current.draft).toEqual(draft);
  });

  it('restores nothing from junk storage', () => {
    for (const junk of ['{', '[]', JSON.stringify({ lines: [{ quantity: 1 }, null, { item: {} }, { item: { id: 'x' }, quantity: 1 }, { item, quantity: 0.0001 }], client: 5 }), JSON.stringify({ lines: [], clientRef: 'not-a-uuid' })]) {
      localStorage.setItem(KEY, junk);
      const { result } = renderHook(() => useNewOrderDraft());
      expect(result.current.draft.lines).toEqual([]);
      expect(result.current.draft.client).toBeNull();
      expect(result.current.draft.clientRef).toMatch(UUID);
    }
  });

  it('reset clears storage and mints a new clientRef', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNewOrderDraft());
    const before = result.current.draft.clientRef;
    act(() => result.current.setDraft({ ...result.current.draft, lines: [{ item, quantity: 1, discount: '' }] }));
    act(() => result.current.reset());
    act(() => void vi.advanceTimersByTime(500));
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(result.current.draft.lines).toEqual([]);
    expect(result.current.draft.clientRef).not.toBe(before);
    clearNewOrderDraft();
  });

  it('clearNewOrderDraft while a write is queued does not resurrect the draft', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNewOrderDraft());
    act(() => result.current.setDraft({ ...result.current.draft, lines: [{ item, quantity: 1, discount: '' }] }));
    clearNewOrderDraft();
    act(() => void vi.advanceTimersByTime(500));
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('storage that throws does not crash', () => {
    vi.useFakeTimers();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const { result } = renderHook(() => useNewOrderDraft());
    act(() => result.current.setDraft({ ...result.current.draft, lines: [{ item, quantity: 1, discount: '' }] }));
    expect(() => act(() => void vi.advanceTimersByTime(500))).not.toThrow();
    expect(result.current.draft.lines).toHaveLength(1);
  });
});
