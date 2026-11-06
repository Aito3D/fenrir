import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import i18next from 'i18next';
import i18n, { LOCALE_LOADERS } from '../../i18n';
import { resetI18nDeadlineForTests, useI18nSettleDeadline, useTrackingLanguage } from '../../hooks/useTrackingLanguage';
import { I18N_ENGLISH_EXTRA_MS, I18N_SETTLE_TIMEOUT_MS } from '../../utils/trackingShell';

afterEach(() => {
  resetI18nDeadlineForTests();
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
  // T-050: result.current never changes after unmount, so the latch is read
  // through a fresh mount instead.
  it('latches nothing when English fails after unmount', async () => {
    vi.useFakeTimers();
    vi.spyOn(i18next, 'hasResourceBundle').mockReturnValue(false);
    let fail: (e: Error) => void = () => {};
    vi.spyOn(LOCALE_LOADERS, 'en').mockReturnValue(new Promise((_r, j) => (fail = j)));
    const { unmount } = renderHook(() => useI18nSettleDeadline());
    await act(async () => {
      vi.advanceTimersByTime(I18N_SETTLE_TIMEOUT_MS + 1);
    });
    unmount();
    await act(async () => {
      fail(new Error('offline'));
    });
    expect(renderHook(() => useI18nSettleDeadline()).result.current).toBe(false);
  });

  // T-056: a failed English load settles at once, not after the extra limit.
  it('settles as soon as English fails to load', async () => {
    vi.useFakeTimers();
    vi.spyOn(i18next, 'hasResourceBundle').mockReturnValue(false);
    vi.spyOn(LOCALE_LOADERS, 'en').mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useI18nSettleDeadline());
    await act(async () => {
      vi.advanceTimersByTime(I18N_SETTLE_TIMEOUT_MS + 1);
    });
    expect(result.current).toBe(true);
  });

  // T-057: the latch is per page session, not per mount.
  it('starts settled in a fresh mount once the deadline has passed, and waits otherwise', async () => {
    vi.useFakeTimers();
    vi.spyOn(i18next, 'hasResourceBundle').mockReturnValue(true);
    const first = renderHook(() => useI18nSettleDeadline());
    expect(first.result.current).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(I18N_SETTLE_TIMEOUT_MS + 1);
    });
    expect(first.result.current).toBe(true);
    first.unmount();
    expect(renderHook(() => useI18nSettleDeadline()).result.current).toBe(true);
    resetI18nDeadlineForTests();
    expect(renderHook(() => useI18nSettleDeadline()).result.current).toBe(false);
  });

  it('registers English that lands after unmount, and latches nothing it did not settle', async () => {
    vi.useFakeTimers();
    vi.spyOn(i18next, 'hasResourceBundle').mockReturnValue(false);
    const add = vi.spyOn(i18next, 'addResourceBundle').mockImplementation(() => i18next);
    const fallback = i18next.options.fallbackLng;
    let release: (v: { default: object }) => void = () => {};
    vi.spyOn(LOCALE_LOADERS, 'en').mockReturnValue(new Promise((r) => (release = r)));
    try {
      const { unmount } = renderHook(() => useI18nSettleDeadline());
      await act(async () => {
        vi.advanceTimersByTime(I18N_SETTLE_TIMEOUT_MS + 1);
      });
      unmount();
      await act(async () => {
        release({ default: {} });
      });
      expect(add).toHaveBeenCalledWith('en', 'translation', {}, true, false);
      expect(renderHook(() => useI18nSettleDeadline()).result.current).toBe(false);
    } finally {
      i18next.options.fallbackLng = fallback;
    }
  });

  // T-058: the title effect does not re-run when English lands.
  it.each([
    ['at the deadline', 0],
    ['after the extra limit', I18N_ENGLISH_EXTRA_MS + 1],
  ])('puts the English page title in the tab when English lands %s', async (_label, lateBy) => {
    vi.useFakeTimers();
    const en = (await LOCALE_LOADERS.en()).default as { aito: { track: { pageTitle: string } } };
    vi.spyOn(i18next, 'hasResourceBundle').mockReturnValue(false);
    const fallback = i18next.options.fallbackLng;
    let release: (v: { default: object }) => void = () => {};
    vi.spyOn(LOCALE_LOADERS, 'en').mockReturnValue(new Promise((r) => (release = r)));
    document.title = 'aito.track.pageTitle';
    try {
      renderHook(() => useI18nSettleDeadline());
      await act(async () => {
        vi.advanceTimersByTime(I18N_SETTLE_TIMEOUT_MS + 1 + lateBy);
      });
      await act(async () => {
        release({ default: en });
      });
      expect(document.title).toBe(en.aito.track.pageTitle);
    } finally {
      i18next.options.fallbackLng = fallback;
    }
  });
});
