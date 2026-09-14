// Campaign-16 golden probe: the English copy of the settings namespace.
//
// The whole-app parity probe (probe_i18n_parity.cjs) pins that every locale
// carries the same KEYS as en.ts; it says nothing about the English text
// itself. Every label, hint and toast on the settings page comes from
// en.settings.* (plus the handful of shared namespaces the settings panels
// reach into), so this probe pins those strings verbatim: a reworded hint or
// a dropped key is a user-visible change even when parity still holds.
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

const en = flat(locales.en);
const namespaces = ['settings', 'backup', 'virtualPrinter', 'failureDetection', 'zoho', 'heimdall', 'ai', 'externalLinks', 'archiveAutoPurge', 'libraryAutoPurge', 'haSensors', 'spoolman', 'users', 'security', 'oidc', 'ldap', 'twoFactor', 'email'];
const out = {};
for (const ns of namespaces) {
  const keys = Object.keys(en).filter((k) => k === ns || k.startsWith(ns + '.')).sort();
  if (keys.length === 0) continue;
  out[ns] = {};
  for (const k of keys) out[ns][k] = en[k];
}
console.log(JSON.stringify(out, null, 1));
