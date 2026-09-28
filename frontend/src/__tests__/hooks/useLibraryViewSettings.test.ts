import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  DEFAULT_LIBRARY_VIEW_SETTINGS,
  LIBRARY_VIEW_SETTINGS_KEY,
  readLibraryViewSettings,
  useLibraryViewSettings,
} from '../../hooks/useLibraryViewSettings';

afterEach(() => localStorage.clear());

describe('useLibraryViewSettings', () => {
  it('starts from defaults with nothing saved', () => {
    const { result } = renderHook(() => useLibraryViewSettings());
    expect(result.current.settings).toEqual(DEFAULT_LIBRARY_VIEW_SETTINGS);
  });

  it('round-trips every field through localStorage', () => {
    const { result } = renderHook(() => useLibraryViewSettings());
    act(() =>
      result.current.update({
        search: 'benchy', filterType: 'stl', filterUsername: 'paul',
        topLevelView: 'external', selectedFolderId: 12, sortField: 'date', sortDirection: 'desc',
      }),
    );
    const { result: second } = renderHook(() => useLibraryViewSettings());
    expect(second.current.settings).toEqual({
      search: 'benchy', filterType: 'stl', filterUsername: 'paul',
      topLevelView: 'external', selectedFolderId: 12, sortField: 'date', sortDirection: 'desc',
    });
  });

  it('merges a partial update and keeps the rest', () => {
    const { result } = renderHook(() => useLibraryViewSettings());
    act(() => result.current.update({ search: 'a' }));
    act(() => result.current.update({ sortField: 'size' }));
    expect(result.current.settings.search).toBe('a');
    expect(result.current.settings.sortField).toBe('size');
  });

  it('seeds sort from the legacy keys when no blob exists, and keeps writing them', () => {
    localStorage.setItem('library-sort-field', 'prints');
    localStorage.setItem('library-sort-direction', 'desc');
    const { result } = renderHook(() => useLibraryViewSettings());
    expect(result.current.settings.sortField).toBe('prints');
    expect(result.current.settings.sortDirection).toBe('desc');
    act(() => result.current.update({ sortField: 'type', sortDirection: 'asc' }));
    expect(localStorage.getItem('library-sort-field')).toBe('type');
    expect(localStorage.getItem('library-sort-direction')).toBe('asc');
  });

  it('falls back to defaults on a corrupt blob', () => {
    localStorage.setItem(LIBRARY_VIEW_SETTINGS_KEY, '{not json');
    expect(readLibraryViewSettings()).toEqual(DEFAULT_LIBRARY_VIEW_SETTINGS);
    localStorage.setItem(LIBRARY_VIEW_SETTINGS_KEY, JSON.stringify({ v: 99, search: 'x' }));
    expect(readLibraryViewSettings()).toEqual(DEFAULT_LIBRARY_VIEW_SETTINGS);
  });

  it('repairs invalid field values one by one', () => {
    localStorage.setItem(
      LIBRARY_VIEW_SETTINGS_KEY,
      JSON.stringify({ v: 1, search: 5, filterType: 'stl', topLevelView: 'cloud', selectedFolderId: 'abc', sortField: 'colour', sortDirection: 'up' }),
    );
    expect(readLibraryViewSettings()).toEqual({ ...DEFAULT_LIBRARY_VIEW_SETTINGS, filterType: 'stl' });
  });

  it('survives a localStorage that throws', () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error('private mode'); };
    try {
      expect(readLibraryViewSettings()).toEqual(DEFAULT_LIBRARY_VIEW_SETTINGS);
    } finally {
      Storage.prototype.getItem = original;
    }
  });
});
