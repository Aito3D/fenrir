// Snapshot probe: the user-visible strings of the Hours tab, in EVERY locale —
// the whole maintenance.hours namespace (flattened), with placeholders listed.
// A key that disappears or is renamed renders the RAW KEY to the user in that
// language; placeholder drift breaks the sentence the same way.
const locales = require("/tmp/fenrir-refactor-probe/hoursI18n.cjs");

function flatten(obj, prefix, into) {
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key, into);
    else into[key] = v;
  }
  return into;
}

const ns = (name) => flatten(((locales[name] || {}).maintenance || {}).hours || {}, "", {});
const names = Object.keys(locales).sort();
for (const name of names) {
  const strings = ns(name);
  const keys = Object.keys(strings);
  console.log(`--- ${name} maintenance.hours (${keys.length} keys)`);
  for (const k of keys) {
    const v = strings[k];
    const placeholders = (String(v).match(/\{\{[a-zA-Z0-9_]+\}\}/g) || []).sort();
    console.log(`${k} = ${JSON.stringify(v)}${placeholders.length ? "  placeholders=" + placeholders.join(",") : ""}`);
  }
}

const en = ns("en");
const enKeys = Object.keys(en);
console.log("\n--- maintenance.hours parity against en");
for (const name of names) {
  const strings = ns(name);
  const missing = enKeys.filter((k) => !(k in strings));
  const extra = Object.keys(strings).filter((k) => !(k in en));
  console.log(`${name}: missing=[${missing.join(",")}] extra=[${extra.join(",")}]`);
}
