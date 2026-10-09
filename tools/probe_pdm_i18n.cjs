// Snapshot probe: the user-visible strings of the Projects-PDM UI, in EVERY
// locale — the whole projectsPdm namespace (flattened), with placeholders
// listed, plus the key set of the upstream projects namespace the feature
// extends. A key that disappears or is renamed renders the RAW KEY to the
// user in that language; placeholder drift breaks the sentence the same way.
const locales = require("/tmp/fenrir-refactor-probe/pdmI18n.cjs");

function flatten(obj, prefix, into) {
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key, into);
    else into[key] = v;
  }
  return into;
}

const names = Object.keys(locales).sort();
for (const name of names) {
  const ns = flatten((locales[name] && locales[name].projectsPdm) || {}, "", {});
  const keys = Object.keys(ns);
  console.log(`--- ${name} projectsPdm (${keys.length} keys)`);
  for (const k of keys) {
    const v = ns[k];
    const placeholders = (String(v).match(/\{\{[a-zA-Z0-9_]+\}\}/g) || []).sort();
    console.log(`${k} = ${JSON.stringify(v)}${placeholders.length ? "  placeholders=" + placeholders.join(",") : ""}`);
  }
}

const en = flatten((locales.en && locales.en.projectsPdm) || {}, "", {});
const enKeys = Object.keys(en);
console.log("\n--- projectsPdm parity against en");
for (const name of names) {
  const ns = flatten((locales[name] && locales[name].projectsPdm) || {}, "", {});
  const missing = enKeys.filter((k) => !(k in ns));
  const extra = Object.keys(ns).filter((k) => !(k in en));
  console.log(`${name}: missing=[${missing.join(",")}] extra=[${extra.join(",")}]`);
}

console.log("\n--- projects namespace key set (en) and parity");
const enProjects = flatten((locales.en && locales.en.projects) || {}, "", {});
console.log(Object.keys(enProjects).join("\n"));
for (const name of names) {
  const ns = flatten((locales[name] && locales[name].projects) || {}, "", {});
  const missing = Object.keys(enProjects).filter((k) => !(k in ns));
  console.log(`${name}: missing=[${missing.join(",")}]`);
}
