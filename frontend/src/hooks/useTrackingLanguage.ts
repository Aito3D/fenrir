import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { availableLanguages } from '../i18n';
import { trackingDefaultLanguage } from '../utils/aitoTracking';

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
