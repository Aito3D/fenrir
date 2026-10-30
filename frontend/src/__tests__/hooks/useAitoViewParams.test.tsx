/**
 * The Aito page's view / archive-filter / archive-sort state, mirrored into
 * the URL. jsdom keeps `window.location` between tests, so each one starts
 * from a clean `/aito`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAitoViewParams } from '../../hooks/useAitoViewParams';

const wrapper = ({ children }: { children: ReactNode }) => <BrowserRouter>{children}</BrowserRouter>;
const params = () => new URLSearchParams(window.location.search);

describe('useAitoViewParams', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/aito');
    localStorage.clear();
  });

  it('starts on the board with no parameters, and keeps the URL clean', () => {
    const { result } = renderHook(() => useAitoViewParams(), { wrapper });
    expect(result.current.view).toBe('board');
    expect(result.current.filter).toBe('all');
    expect(result.current.sort).toBe('finishedDesc');
    expect(window.location.search).toBe('');
  });

  it('reads an archive, its filter and its sort back from the URL', () => {
    window.history.replaceState({}, '', '/aito?view=done&filter=declined&sort=amountDesc');
    const { result } = renderHook(() => useAitoViewParams(), { wrapper });
    expect(result.current.view).toBe('done');
    expect(result.current.filter).toBe('declined');
    expect(result.current.sort).toBe('amountDesc');
  });

  it('ignores values it does not know', () => {
    window.history.replaceState({}, '', '/aito?view=attic&filter=lost&sort=random');
    const { result } = renderHook(() => useAitoViewParams(), { wrapper });
    expect(result.current.view).toBe('board');
    expect(result.current.filter).toBe('all');
    expect(result.current.sort).toBe('finishedDesc');
  });

  it('mirrors the view, filter and sort into the URL while an archive is open, and clears them on the way back', () => {
    const { result } = renderHook(() => useAitoViewParams(), { wrapper });
    act(() => result.current.setView('done'));
    act(() => result.current.setFilter('declined'));
    act(() => result.current.setSort('clientAsc'));
    expect(params().get('view')).toBe('done');
    expect(params().get('filter')).toBe('declined');
    expect(params().get('sort')).toBe('clientAsc');

    act(() => result.current.setView('board'));
    expect(window.location.search).toBe('');
    // The filter went with the view; the sort is still the preference.
    expect(result.current.filter).toBe('all');
    expect(result.current.sort).toBe('clientAsc');
  });

  it('keeps the sort but not the filter when moving to the trash', () => {
    window.history.replaceState({}, '', '/aito?view=done&filter=declined&sort=clientAsc');
    const { result } = renderHook(() => useAitoViewParams(), { wrapper });
    act(() => result.current.setView('trash'));
    expect(params().get('view')).toBe('trash');
    expect(params().get('filter')).toBeNull();
    expect(params().get('sort')).toBe('clientAsc');
  });

  it('leaves another parameter alone', () => {
    window.history.replaceState({}, '', '/aito?card=41');
    const { result } = renderHook(() => useAitoViewParams(), { wrapper });
    act(() => result.current.setView('done'));
    expect(params().get('card')).toBe('41');
    expect(params().get('view')).toBe('done');
  });

  it('remembers the sort for the next visit, and lets the URL override it', () => {
    const first = renderHook(() => useAitoViewParams(), { wrapper });
    act(() => first.result.current.setSort('createdAsc'));
    first.unmount();

    window.history.replaceState({}, '', '/aito');
    const second = renderHook(() => useAitoViewParams(), { wrapper });
    expect(second.result.current.sort).toBe('createdAsc');
    second.unmount();

    window.history.replaceState({}, '', '/aito?view=done&sort=amountDesc');
    const third = renderHook(() => useAitoViewParams(), { wrapper });
    expect(third.result.current.sort).toBe('amountDesc');
  });
});
