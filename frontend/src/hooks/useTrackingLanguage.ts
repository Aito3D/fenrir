import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18next from 'i18next';
import { availableLanguages, LOCALE_LOADERS } from '../i18n';
import { trackingDefaultLanguage } from '../utils/aitoTracking';
import { I18N_SETTLE_TIMEOUT_MS } from '../utils/trackingShell';

const SUPPORTED = availableLanguages.map((l) => l.code);

/** The public tracking pages' language: the app's i18next, with one twist
 *  — a browser that asks for nothing the app ships gets French, not
 *  English (see trackingDefaultLanguage). Runs once on mount, before the
 *  first paint of data; the pill's own changes go straight through
 *  i18next, which remembers them in localStorage like the operator's
 *  picker does. Also keeps <html lang> and the tab title in step for
 *  screen readers. */
export function useTrackingLanguage() {
  const { t, i18n, ready } = useTranslation();
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem('bambutrack_language');
    } catch {
      /* private mode: no memory, the browser language decides */
    }
    const lng = trackingDefaultLanguage(stored, navigator.languages ?? [navigator.language], SUPPORTED);
    if (lng && lng !== i18n.resolvedLanguage) void i18n.changeLanguage(lng);
  }, [i18n]);
  const lng = i18n.resolvedLanguage ?? i18n.language;
  useEffect(() => {
    document.documentElement.lang = lng;
    document.title = t('aito.track.pageTitle');
  }, [lng, t]);
  return { t, lng, ready };
}

/** The tracking pages' locale deadline, shared by both: true once
 *  I18N_SETTLE_TIMEOUT_MS has passed (a one-way latch) and, if the active
 *  language's bundle still has not arrived, English is in place. English is
 *  not bundled in the entry any more, so without this the page would render
 *  raw `aito.track.*` keys. English goes in as the fallback language
 *  (not into the active one), so a stalled locale that lands later wins. */
export function useI18nSettleDeadline(): boolean {
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        if (!i18next.languages?.some((l) => i18next.hasResourceBundle(l, 'translation'))) {
          try {
            i18next.addResourceBundle('en', 'translation', (await LOCALE_LOADERS.en()).default, true, false);
            i18next.options.fallbackLng = ['en'];
          } catch {
            /* English failed too: settle anyway, nothing else to show */
          }
        }
        if (!cancelled) setTimedOut(true);
      })();
    }, I18N_SETTLE_TIMEOUT_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);
  return timedOut;
}
