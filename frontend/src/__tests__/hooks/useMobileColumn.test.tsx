import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMobileColumn, MOBILE_COLUMN_STORAGE_KEY } from '../../hooks/useMobileColumn';

const IDS = ['devis', 'waiting', 'scan', 'model', 'print', 'finish'] as const;

describe('useMobileColumn', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('starts on the first column', () => {
    const { result } = renderHook(() => useMobileColumn(IDS));
    expect(result.current[0]).toBe(0);
  });

  it('restores and stores by id', () => {
    sessionStorage.setItem(MOBILE_COLUMN_STORAGE_KEY, 'print');
    const { result } = renderHook(() => useMobileColumn(IDS));
    expect(result.current[0]).toBe(4);
    act(() => result.current[1](1));
    expect(result.current[0]).toBe(1);
    expect(sessionStorage.getItem(MOBILE_COLUMN_STORAGE_KEY)).toBe('waiting');
  });

  it('ignores a stale id and clamps out-of-range indexes', () => {
    sessionStorage.setItem(MOBILE_COLUMN_STORAGE_KEY, 'gone');
    const { result } = renderHook(() => useMobileColumn(IDS));
    expect(result.current[0]).toBe(0);
    act(() => result.current[1](99));
    expect(result.current[0]).toBe(5);
  });

  it('uses its own storage key when given one', () => {
    sessionStorage.setItem('aito.tablet.first', 'scan');
    const { result } = renderHook(() => useMobileColumn(IDS, 'aito.tablet.first'));
    expect(result.current[0]).toBe(2);
    act(() => result.current[1](3));
    expect(sessionStorage.getItem('aito.tablet.first')).toBe('model');
    expect(sessionStorage.getItem(MOBILE_COLUMN_STORAGE_KEY)).toBeNull();
  });

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const { result } = renderHook(() => useMobileColumn(IDS));
    expect(result.current[0]).toBe(0);
    act(() => result.current[1](2));
    expect(result.current[0]).toBe(2);
  });
});
