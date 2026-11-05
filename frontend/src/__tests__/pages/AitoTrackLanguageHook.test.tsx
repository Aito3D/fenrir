import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import i18next from 'i18next';
import i18n, { LOCALE_LOADERS } from '../../i18n';
import { useI18nSettleDeadline, useTrackingLanguage } from '../../hooks/useTrackingLanguage';
import { I18N_SETTLE_TIMEOUT_MS } from '../../utils/trackingShell';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useTrackingLanguage fallbacks', () => {
  it('reads navigator.language when the browser exposes no languages list', async () => {
    await i18n.changeLanguage('de');
    const languages = Object.getOwnPropertyDescriptor(Navigator.prototype, 'languages');
    window.localStorage.removeItem('bambutrack_language');
    Object.defineProperty(navigator, 'languages', { configurable: true, value: undefined });
    try {
      const { result } = renderHook(() => useTrackingLanguage());
      // 'en-US' (jsdom's navigator.language) is supported, so no switch to French.
      expect(result.current.lng).toBe('de');
    } finally {
      if (languages) Object.defineProperty(Navigator.prototype, 'languages', languages);
      delete (navigator as unknown as Record<string, unknown>).languages;
      await i18n.changeLanguage('en');
    }
  });

  it('falls back to i18n.language while no language has resolved yet', () => {
    Object.defineProperty(i18n, 'resolvedLanguage', { configurable: true, value: undefined });
    try {
      const { result } = renderHook(() => useTrackingLanguage());
      expect(result.current.lng).toBe(i18n.language);
    } finally {
      delete (i18n as unknown as Record<string, unknown>).resolvedLanguage;
    }
  });
});

describe('useI18nSettleDeadline', () => {
  it('does not report the deadline when unmounted while English is still loading', async () => {
    vi.useFakeTimers();
    vi.spyOn(i18next, 'hasResourceBundle').mockReturnValue(false);
    vi.spyOn(i18next, 'addResourceBundle').mockImplementation(() => i18next);
    const fallback = i18next.options.fallbackLng;
    let release: (v: { default: object }) => void = () => {};
    vi.spyOn(LOCALE_LOADERS, 'en').mockReturnValue(new Promise((r) => (release = r)));
    try {
      const { result, unmount } = renderHook(() => useI18nSettleDeadline());
      await act(async () => {
        vi.advanceTimersByTime(I18N_SETTLE_TIMEOUT_MS + 1);
      });
      unmount();
      await act(async () => {
        release({ default: {} });
      });
      expect(result.current).toBe(false);
    } finally {
      i18next.options.fallbackLng = fallback;
    }
  });
});
