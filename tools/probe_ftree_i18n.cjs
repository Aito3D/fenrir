// Golden probe: the `filamentTrees` translation namespace in EVERY locale file of
// frontend/src/i18n/locales/ (the directory is listed at run time, so a new locale is
// picked up). Prints the English keys with their values and placeholders, then per
// locale: the sorted key paths, the key count, a digest of the values, the placeholders
// that differ from English, and parity against English. A moved, renamed or retranslated
// key moves this file. Plus the nav label(s) that point at the page.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const dir = path.join(root, "frontend/src/i18n/locales");
const out = "/tmp/fenrir-refactor-ftree-probe";
fs.mkdirSync(out, { recursive: true });
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts")).sort();
const entry = path.join(out, "ftreeI18nEntry.ts");
fs.writeFileSync(entry, files.map((f, i) => `export { default as l${i} } from ${JSON.stringify(path.join(dir, f.replace(/\.ts$/, "")))};`).join("\n") + "\n");
execFileSync(path.join(root, "frontend/node_modules/.bin/rolldown"), [entry, "--format", "cjs", "--file", path.join(out, "ftreeI18n.cjs")], { stdio: "ignore", cwd: root });
const bundle = require(path.join(out, "ftreeI18n.cjs"));

function flatten(obj, prefix, into) {
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key, into);
    else into[key] = v;
  }
  return into;
}
const placeholders = (v) => (String(v).match(/\{\{[a-zA-Z0-9_]+\}\}/g) || []).sort().join(",");
const strings = (i) => {
  const l = bundle[`l${i}`] || {};
  const s = flatten(l.filamentTrees || {}, "filamentTrees", {});
  for (const k of Object.keys(l.nav || {})) if (/filament/i.test(k)) s[`nav.${k}`] = l.nav[k];
  return s;
};
const en = strings(files.indexOf("en.ts"));
const enKeys = Object.keys(en).sort();
console.log(`locale files (${files.length}): ${files.join(" ")}`);
console.log(`--- en values (${enKeys.length} keys)`);
for (const k of enKeys) console.log(`${k} = ${JSON.stringify(en[k])}${placeholders(en[k]) ? "  placeholders=" + placeholders(en[k]) : ""}`);
files.forEach((f, i) => {
  const s = strings(i);
  const keys = Object.keys(s).sort();
  const digest = crypto.createHash("sha256").update(keys.map((k) => `${k}=${JSON.stringify(s[k])}`).join("\n")).digest("hex").slice(0, 16);
  console.log(`\n--- ${f} keys=${keys.length} values-sha256=${digest}`);
  console.log(`missing=[${enKeys.filter((k) => !(k in s)).join(",")}] extra=[${keys.filter((k) => !(k in en)).join(",")}]`);
  console.log(`same-as-en=${keys.filter((k) => f !== "en.ts" && s[k] === en[k]).length} non-string=[${keys.filter((k) => typeof s[k] !== "string").join(",")}]`);
  const drift = keys.filter((k) => k in en && placeholders(s[k]) !== placeholders(en[k]));
  console.log(`placeholder-drift=[${drift.map((k) => `${k}:${placeholders(s[k])}`).join(" ")}]`);
  for (const k of keys) console.log(k);
});
