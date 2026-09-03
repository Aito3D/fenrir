// Campaign-9 golden probe: whole-app i18n key parity.
//
// A key that exists in en.ts but is missing from de.ts renders the RAW KEY to
// a German user -- invisible to every test that asserts on the English UI.
// Placeholder drift ({{count}} -> {{n}}) breaks the sentence the same way.
// This probe pins, for every locale: the total key count, the keys missing
// relative to en, the extra keys, and any key whose {{placeholder}} set
// differs from en's.
const locales = require('/tmp/bambuddy-refactor-probe/i18nAll.cjs');

const flat = (obj, prefix = '', out = {}) => {
  for (const k of Object.keys(obj || {})) {
    const v = obj[k];
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, path, out);
    else out[path] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
};
const placeholders = (s) => [...String(s).matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]).sort();

const names = Object.keys(locales).sort();
const en = flat(locales.en);
const enKeys = Object.keys(en).sort();
const out = { en_key_count: enKeys.length, locales: {} };

for (const name of names) {
  if (name === 'en') continue;
  const f = flat(locales[name]);
  const keys = new Set(Object.keys(f));
  const missing = enKeys.filter((k) => !keys.has(k));
  const extra = [...keys].filter((k) => !(k in en)).sort();
  const placeholderMismatch = enKeys
    .filter((k) => keys.has(k))
    .filter((k) => JSON.stringify(placeholders(en[k])) !== JSON.stringify(placeholders(f[k])))
    .sort();
  out.locales[name] = {
    key_count: keys.size,
    missing_vs_en: missing,
    extra_vs_en: extra,
    placeholder_mismatch_vs_en: placeholderMismatch,
  };
}
console.log(JSON.stringify(out, null, 1));
