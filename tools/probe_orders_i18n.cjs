// Snapshot probe: the user-visible strings of the Order Board, in EVERY locale —
// the whole `orders` namespace (flattened) plus the sidebar and settings-tab
// labels and the shared Cancel label of the order bars, with placeholders listed. A key that disappears or is renamed renders
// the RAW KEY to the user in that language; placeholder drift breaks the
// sentence the same way.
const locales = require("/tmp/fenrir-refactor-probe/ordersI18n.cjs");

function flatten(obj, prefix, into) {
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key, into);
    else into[key] = v;
  }
  return into;
}

const ns = (name) => {
  const l = locales[name] || {};
  const out = flatten(l.orders || {}, "orders", {});
  out["nav.orders"] = (l.nav || {}).orders;
  out["settings.tabs.orders"] = ((l.settings || {}).tabs || {}).orders;
  out["common.cancel"] = (l.common || {}).cancel; // the one shared key the order bars render
  return out;
};
const names = Object.keys(locales).sort();
for (const name of names) {
  const strings = ns(name);
  const keys = Object.keys(strings);
  console.log(`--- ${name} orders (${keys.length} keys)`);
  for (const k of keys) {
    const v = strings[k];
    const placeholders = (String(v).match(/\{\{[a-zA-Z0-9_]+\}\}/g) || []).sort();
    console.log(`${k} = ${JSON.stringify(v)}${placeholders.length ? "  placeholders=" + placeholders.join(",") : ""}`);
  }
}

const en = ns("en");
const enKeys = Object.keys(en);
console.log("\n--- orders parity against en");
for (const name of names) {
  const strings = ns(name);
  const missing = enKeys.filter((k) => !(k in strings));
  const extra = Object.keys(strings).filter((k) => !(k in en));
  console.log(`${name}: missing=[${missing.join(",")}] extra=[${extra.join(",")}]`);
}
