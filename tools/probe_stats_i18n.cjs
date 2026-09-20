// Golden probe: the statistics view's translated strings, in every locale.
//
// Every label, tab, legend and finding on the five screens and the strip is a
// t() call under `aito.stats`. A key that is renamed or dropped renders the
// RAW KEY to the user in all fourteen languages, and a placeholder that drifts
// ({{days}} -> {{count}}) breaks the sentence — neither shows up in a test
// asserting on one English string.
//
// The probe records STRUCTURE, not translations: the sorted key paths, and per
// key the sorted placeholder set. That fails on a key or placeholder change
// and stays quiet on a reworded French sentence, which is what a refactor
// campaign should be allowed to leave alone.
//
// The bundle is produced by rolldown into /tmp/fenrir-refactor-probe/ by the
// probe command in PROBES.json before this script runs.
const locales = require("/tmp/fenrir-refactor-probe/statsI18n.cjs");

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)[^}]*\}\}/g;

/** Flatten a nested translation object into `a.b.c` -> value. */
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
  const stats = ((locales[name] || {}).aito || {}).stats || {};
  const flat = flatten(stats, "", {});
  const keys = Object.keys(flat).sort();
  out[name] = {
    count: keys.length,
    // One line per key: the path, then the placeholders it carries. The
    // translation itself is deliberately not recorded.
    keys: keys.map((k) => [k, placeholders(flat[k])]),
  };
}

// The English tree is the reference the parity gate compares against; call out
// any locale that disagrees with it, so a diff here names the drift rather
// than leaving it to be spotted among fourteen key lists.
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
