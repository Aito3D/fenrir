// Golden probe (Q1): the `queue` translation namespace in EVERY locale file of
// frontend/src/i18n/locales/ (the directory is listed at run time, so a new locale is
// picked up). Prints the English key paths (sorted), then per locale: the key count, a
// digest of its values, and the keys missing from / extra to English. A moved, renamed,
// dropped or retranslated `queue.*` key moves this file.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const dir = path.join(root, "frontend/src/i18n/locales");
const out = "/tmp/fenrir-queue-probe";
fs.mkdirSync(out, { recursive: true });
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts")).sort();
const entry = path.join(out, "queueI18nEntry.ts");
fs.writeFileSync(entry, files.map((f, i) => `export { default as l${i} } from ${JSON.stringify(path.join(dir, f.replace(/\.ts$/, "")))};`).join("\n") + "\n");
execFileSync(path.join(root, "frontend/node_modules/.bin/rolldown"), [entry, "--format", "cjs", "--file", path.join(out, "queueI18n.cjs")], { stdio: "ignore", cwd: root });
const bundle = require(path.join(out, "queueI18n.cjs"));

function flatten(obj, prefix, into) {
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key, into);
    else into[key] = v;
  }
  return into;
}
const strings = (i) => flatten((bundle[`l${i}`] || {}).queue || {}, "queue", {});
const en = strings(files.indexOf("en.ts"));
const enKeys = Object.keys(en).sort();
console.log(`locale files (${files.length}): ${files.join(" ")}`);
console.log(`--- en keys (${enKeys.length})`);
for (const k of enKeys) console.log(k);
console.log("--- per locale");
files.forEach((f, i) => {
  const s = strings(i);
  const keys = Object.keys(s).sort();
  const digest = crypto.createHash("sha256").update(keys.map((k) => `${k}=${JSON.stringify(s[k])}`).join("\n")).digest("hex").slice(0, 16);
  console.log(`${f} keys=${keys.length} values-sha256=${digest} missing=[${enKeys.filter((k) => !(k in s)).join(",")}] extra=[${keys.filter((k) => !(k in en)).join(",")}]`);
});
