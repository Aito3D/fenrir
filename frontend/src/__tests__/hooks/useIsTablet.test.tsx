import { describe, it, expect, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useIsTablet } from '../../hooks/useIsTablet';

const original = window.matchMedia;
function stub(width: number, coarse: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => {
      const min = /min-width:\s*(\d+)px/.exec(query);
      const wantsCoarse = /pointer:\s*coarse/.test(query);
      const matches = (!min || width >= Number(min[1])) && (!wantsCoarse || coarse);
      return { ...original(query), matches, media: query };
    },
  });
}
afterEach(() => Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: original }));

describe('useIsTablet', () => {
  it('is true for a touch screen of 768 px and wider', () => {
    stub(1180, true);
    expect(renderHook(() => useIsTablet()).result.current).toBe(true);
  });

  it('is false for a mouse-primary screen, even a touchscreen laptop', () => {
    stub(1366, false);
    expect(renderHook(() => useIsTablet()).result.current).toBe(false);
  });

  it('is false below 768 px (the phone board)', () => {
    stub(390, true);
    expect(renderHook(() => useIsTablet()).result.current).toBe(false);
  });
});
