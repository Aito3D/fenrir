import i18n, { type BackendModule, type ReadCallback } from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// English ships in the entry bundle: it is the fallback language and must be
// available synchronously. Every other locale (~350 KB of source each) is
// code-split and fetched on demand by the backend below, keeping ~4 MB of
// translations out of the initial download.
import en from './locales/en';

const LOCALE_LOADERS: Record<string, () => Promise<{ default: object }>> = {
  de: () => import('./locales/de'),
  es: () => import('./locales/es'),
  fr: () => import('./locales/fr'),
  ja: () => import('./locales/ja'),
  it: () => import('./locales/it'),
  ko: () => import('./locales/ko'),
  'pt-BR': () => import('./locales/pt-BR'),
  'zh-CN': () => import('./locales/zh-CN'),
  'zh-TW': () => import('./locales/zh-TW'),
  tr: () => import('./locales/tr'),
  ru: () => import('./locales/ru'),
};

// Minimal i18next backend: resolves a language to its lazily imported
// locale chunk. Combined with `partialBundledLanguages`, i18next only calls
// this for languages missing from `resources` (i.e. everything but en).
const lazyLocaleBackend: BackendModule = {
  type: 'backend',
  init: () => {},
  read: (lng: string, _ns: string, callback: ReadCallback) => {
    const load = LOCALE_LOADERS[lng];
    if (!load) {
      callback(null, {});
      return;
    }
    load().then(
      (mod) => callback(null, mod.default),
      (err) => callback(err, null),
    );
  },
};

const resources = {
  en: { translation: en },
};

const SUPPORTED_LNGS = ['en', 'de', 'es', 'fr', 'ja', 'it', 'ko', 'pt-BR', 'ru', 'tr', 'zh-CN', 'zh-TW'];
const APPLIANCE_CONSUMED_KEY = 'bambuddy_appliance_locale_consumed';

i18n
  .use(lazyLocaleBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    // resources only bundles en; other languages come from lazyLocaleBackend.
    partialBundledLanguages: true,
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LNGS,

    detection: {
      // Order of detection methods
      order: ['localStorage', 'navigator', 'htmlTag'],
      // Key to use in localStorage
      lookupLocalStorage: 'bambutrack_language',
      // Cache user language
      caches: ['localStorage'],
    },

    interpolation: {
      escapeValue: false, // React already escapes
    },

    react: {
      useSuspense: false,
      // Re-render translated components when a lazily fetched locale bundle
      // arrives, not only on languageChanged (English shows in the interim).
      bindI18n: 'languageChanged loaded',
    },
  });

/**
 * Bambuddy Appliance hook: on the first SPA load after the firstboot wizard
 * runs, /api/v1/system/appliance returns the locale the user picked. We
 * apply it once (gated by a localStorage flag) and stop. On non-appliance
 * installs the endpoint either 404s or returns nulls — silent no-op.
 *
 * This runs AFTER i18n.init so the LanguageDetector has already populated a
 * default; we override that default exactly once for fresh appliances. The
 * appliance is then "consumed" and the language picker is the only way to
 * change locale going forward (the wizard ran once; future intent comes from
 * the running UI).
 */
function applyApplianceLocale() {
  if (typeof window === 'undefined' || !window.localStorage) return;
  const storage = window.localStorage;
  if (typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') return;
  if (storage.getItem(APPLIANCE_CONSUMED_KEY)) return;

  fetch('/api/v1/system/appliance')
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data || typeof data.locale !== 'string') return;
      if (!SUPPORTED_LNGS.includes(data.locale)) return;
      i18n.changeLanguage(data.locale);
      storage.setItem(APPLIANCE_CONSUMED_KEY, '1');
    })
    .catch(() => {
      // Endpoint absent or unreachable — non-appliance install or dev environment.
      // Leave the detector's choice in place.
    });
}

applyApplianceLocale();

export default i18n;

// Helper to get available languages
export const availableLanguages = [
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'de', name: 'German', nativeName: 'Deutsch' },
  { code: 'es', name: 'Spanish', nativeName: 'Español' },
  { code: 'fr', name: 'French', nativeName: 'Français' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano' },
  { code: 'ko', name: 'Korean', nativeName: '한국어' },
  { code: 'pt-BR', name: 'Portuguese (Brazil)', nativeName: 'Português (Brasil)' },
  { code: 'zh-CN', name: 'Chinese (Simplified)', nativeName: '简体中文' },
  { code: 'zh-TW', name: 'Chinese (Traditional)', nativeName: '繁體中文' },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский' },
];
