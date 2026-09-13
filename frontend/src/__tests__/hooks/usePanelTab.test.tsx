import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePanelTab, PANEL_TAB_STORAGE_KEY } from '../../hooks/usePanelTab';

const IDS = ['details', 'activity'] as const;

beforeEach(() => {
  sessionStorage.clear();
});

describe('usePanelTab', () => {
  it('starts on the first tab when nothing is remembered', () => {
    const { result } = renderHook(() => usePanelTab(IDS));
    expect(result.current[0]).toBe('details');
  });

  it('remembers the chosen tab for the session, so the next panel opens on it', () => {
    const first = renderHook(() => usePanelTab(IDS));
    act(() => first.result.current[1]('activity'));
    expect(first.result.current[0]).toBe('activity');
    first.unmount();

    const second = renderHook(() => usePanelTab(IDS));
    expect(second.result.current[0]).toBe('activity');
  });

  it('ignores a remembered value that is not one of the tabs', () => {
    sessionStorage.setItem(PANEL_TAB_STORAGE_KEY, 'billing');
    const { result } = renderHook(() => usePanelTab(IDS));
    expect(result.current[0]).toBe('details');
  });
});
