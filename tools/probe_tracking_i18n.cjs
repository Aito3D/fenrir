// Golden probe: the tracking page's translated strings, in every locale.
//
// Every word the client reads on /t and /t/<code> — stage names, status
// titles and sub-lines, the ETA phrases, the parts list, invoice and payment
// wording, the code-entry hints and errors, the language selector — is a t()
// call under `aito.track`, and the detail panel's link controls read the flat
// `aito.tracking*` keys next to it. A key that is renamed or dropped renders
// the RAW KEY to the client in all fourteen languages, and a placeholder that
// drifts ({{date}} -> {{day}}) breaks the sentence — neither shows up in a
// test asserting on one English string.
//
// Records STRUCTURE, not translations: the sorted key paths and per key the
// sorted placeholder set. Fails on a key or placeholder change, stays quiet
// on a reworded sentence — what a refactor campaign should be allowed to
// leave alone. The English tree is the reference; per-locale drift is called
// out by name.
//
// The bundle is produced by rolldown into /tmp/fenrir-refactor-probe/ by the
// probe command in PROBES.json before this script runs.
const locales = require("/tmp/fenrir-refactor-probe/trackingI18n.cjs");

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)[^}]*\}\}/g;

function flatten(node, prefix, out) {
  for (const key of Object.keys(node)) {
    const value = node[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) flatten(value, path, out);
    else out[path] = value;
  }
  return out;
}

function placeholders(value) {
  if (typeof value !== "string") return null;
  const found = new Set();
  let m;
  while ((m = PLACEHOLDER.exec(value)) !== null) found.add(m[1]);
  PLACEHOLDER.lastIndex = 0;
  return [...found].sort();
}

const out = {};
for (const name of Object.keys(locales).sort()) {
  const aito = (locales[name] || {}).aito || {};
  const flat = flatten(aito.track || {}, "track", {});
  for (const key of Object.keys(aito)) {
    if (key.startsWith("tracking") && typeof aito[key] !== "object") flat[key] = aito[key];
  }
  const keys = Object.keys(flat).sort();
  out[name] = { count: keys.length, keys: keys.map((k) => [k, placeholders(flat[k])]) };
}

const reference = new Set(out.en ? out.en.keys.map(([k]) => k) : []);
out._parity = {};
for (const name of Object.keys(out).filter((n) => !n.startsWith("_") && n !== "en")) {
  const mine = new Set(out[name].keys.map(([k]) => k));
  out._parity[name] = {
    missing: [...reference].filter((k) => !mine.has(k)).sort(),
    extra: [...mine].filter((k) => !reference.has(k)).sort(),
  };
}

console.log(JSON.stringify(out, null, 2));
