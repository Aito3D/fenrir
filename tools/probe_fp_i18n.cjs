// Snapshot probe: the user-visible strings the filament-profiles Zoho sync
// renders, in EVERY locale.
//
// The sync's whole result surface is text: "Priced 2, 3 already current",
// the per-profile reason ("several items matched"), and the button label. A
// key that disappears or is renamed renders the RAW KEY to the user in that
// language, which no test asserting on the English UI would catch. Placeholder
// drift ({{priced}} -> {{count}}) breaks the sentence the same way.
//
// The bundle is produced by rolldown into /tmp/bambuddy-refactor-probe/ by the
// probe command in PROBES.json before this script runs.
const locales = require("/tmp/bambuddy-refactor-probe/fpI18n.cjs");

// Every filamentProfiles key whose name relates to the Zoho price sync.
const KEY_RE = /^zoho|^sync|Zoho/;

const names = Object.keys(locales).sort();
for (const name of names) {
  const fp = (locales[name] && locales[name].filamentProfiles) || {};
  const keys = Object.keys(fp).filter((k) => KEY_RE.test(k)).sort();
  console.log(`--- ${name} (${keys.length} keys)`);
  for (const k of keys) {
    const v = fp[k];
    const placeholders = (String(v).match(/\{\{[a-zA-Z0-9_]+\}\}/g) || []).sort();
    console.log(`${k} = ${JSON.stringify(v)}${placeholders.length ? "  placeholders=" + placeholders.join(",") : ""}`);
  }
}

// Parity: any key present in English but missing elsewhere renders as the raw
// key for that language's users.
const en = (locales.en && locales.en.filamentProfiles) || {};
const enKeys = Object.keys(en).filter((k) => KEY_RE.test(k)).sort();
console.log("\n--- parity against en");
for (const name of names) {
  const fp = (locales[name] && locales[name].filamentProfiles) || {};
  const missing = enKeys.filter((k) => !(k in fp));
  const extra = Object.keys(fp).filter((k) => KEY_RE.test(k) && !enKeys.includes(k)).sort();
  console.log(`${name}: missing=[${missing.join(",")}] extra=[${extra.join(",")}]`);
}
