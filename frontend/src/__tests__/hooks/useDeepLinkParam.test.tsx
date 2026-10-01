/**
 * useDeepLinkParam: one URL search parameter, read and cleared. Clearing must
 * drop only that parameter and replace the history entry, so a refresh (or
 * Back) does not reopen what the link already opened.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { useDeepLinkParam } from '../../hooks/useDeepLinkParam';

const wrapper = ({ children }: { children: ReactNode }) => <BrowserRouter>{children}</BrowserRouter>;

describe('useDeepLinkParam', () => {
  const original = window.location.href;
  afterEach(() => window.history.replaceState({}, '', original));

  it('reads the parameter, or null when it is absent', () => {
    window.history.pushState({}, '', '/aito?card=41');
    const { result } = renderHook(() => useDeepLinkParam('card'), { wrapper });
    expect(result.current[0]).toBe('41');

    const other = renderHook(() => useDeepLinkParam('focus'), { wrapper });
    expect(other.result.current[0]).toBeNull();
  });

  it('clear removes only that parameter and replaces the history entry', () => {
    window.history.pushState({}, '', '/aito?card=41&tab=x');
    const lengthBefore = window.history.length;
    const { result } = renderHook(() => useDeepLinkParam('card'), { wrapper });

    act(() => result.current[1]());

    expect(result.current[0]).toBeNull();
    expect(window.location.pathname).toBe('/aito');
    expect(window.location.search).toBe('?tab=x');
    expect(window.history.length).toBe(lengthBefore);
  });
});
