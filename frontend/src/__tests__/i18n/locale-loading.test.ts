/**
 * Only English is bundled; the other languages load when used (#3175).
 */
import { describe, it, expect, afterEach } from 'vitest';
import i18n, { localeBackend } from '../../i18n';
import en from '../../i18n/locales/en';
import de from '../../i18n/locales/de';
import fr from '../../i18n/locales/fr';

function read(language: string) {
  return new Promise<{ error: unknown; data: unknown }>((resolve) => {
    localeBackend.read(language, 'translation', (error, data) => resolve({ error, data }));
  });
}

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('locale loading', () => {
  it('starts with English only', () => {
    expect(i18n.hasResourceBundle('en', 'translation')).toBe(true);
    expect(i18n.hasResourceBundle('ja', 'translation')).toBe(false);
    expect(i18n.t('nav.printers')).toBe(en.nav.printers);
  });

  it('hands i18next the file of the language asked for', async () => {
    const { error, data } = await read('de');

    expect(error).toBeNull();
    expect(data).toEqual(de);
  });

  it('answers an unknown language with nothing, so English stays the fallback', async () => {
    const { error, data } = await read('xx');

    expect(error).toBeNull();
    expect(data).toEqual({});
  });

  it('loads a language before switching to it', async () => {
    expect(i18n.hasResourceBundle('ja', 'translation')).toBe(false);

    await i18n.changeLanguage('ja');

    expect(i18n.language).toBe('ja');
    expect(i18n.hasResourceBundle('ja', 'translation')).toBe(true);
    expect(i18n.t('nav.printers')).not.toBe(en.nav.printers);
  });

  it('loads a regional language by its full code', async () => {
    await i18n.changeLanguage('pt-BR');

    expect(i18n.hasResourceBundle('pt-BR', 'translation')).toBe(true);
    expect(i18n.t('nav.printers')).not.toBe(en.nav.printers);
  });

  it('maps a browser region to its supported language', async () => {
    await i18n.changeLanguage('de-AT');

    expect(i18n.t('nav.printers')).toBe(de.nav.printers);
  });
});

// English used to ship inside the entry chunk as the synchronous fallback,
// so a French user downloaded both string tables (~300 KB gzipped). Every
// locale, English included, now loads on demand, and there is no fallback
// language: the parity gate (`check:i18n`) guarantees every key exists in
// every locale, which is what makes that safe.
describe('English is a locale like the others', () => {
  it('is loaded through the backend, not bundled', async () => {
    const { error, data } = await read('en');
    expect(error).toBeNull();
    expect(data).toEqual(en);
  });

  it('has no fallback language', () => {
    expect(i18n.options.fallbackLng).toBe(false);
  });

  it('renders keys from the loaded locale without an English bundle', async () => {
    await i18n.changeLanguage('fr');
    i18n.removeResourceBundle('en', 'translation');
    expect(i18n.hasResourceBundle('en', 'translation')).toBe(false);
    expect(i18n.t('nav.printers')).toBe(fr.nav.printers);
    expect(i18n.t('aito.urgent')).toBe(fr.aito.urgent);
  });
});
