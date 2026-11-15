// Golden probe: the filament-tree UI's pure modules — the Orca settings layout (TABS:
// labels, keys, units, kinds, options, icons, flags), PA_KEY, MAPPED_KEYS, keyLabel,
// every paGcode function over a table of inputs, and errorMessage. Pure values only.
const bundle = require("/tmp/fenrir-refactor-ftree-probe/ftreeFrontend.cjs");
const iconName = (i) => (i ? i.displayName || i.name || String(i) : i);
const call = (fn, ...args) => {
  try { const v = fn(...args); return v === undefined ? "__undefined__" : v; }
  catch (e) { return { __threw__: `${e.name}: ${e.message}` }; }
};
const out = {};

const L = bundle.layout;
out.layoutExports = Object.keys(L).sort();
out.PA_KEY = L.PA_KEY;
out.DEPENDENCIES_ICON = iconName(L.DEPENDENCIES_ICON);
out.TABS = L.TABS.map((tab) => ({ ...tab, sections: tab.sections.map((s) => ({ ...s, icon: iconName(s.icon) })) }));
out.MAPPED_KEYS = [...L.MAPPED_KEYS].sort();
out.mappedKeyCount = L.MAPPED_KEYS.size;
const t = (k) => `T(${k})`;
const tMissing = (k) => k; // i18next returns the key itself when a translation is missing
out.keyLabel = {};
for (const key of [...out.MAPPED_KEYS, "not_a_mapped_key", "", "filament_start_gcode", "Some Key"]) {
  out.keyLabel[key] = { translated: call(L.keyLabel, t, key), missing: call(L.keyLabel, tMissing, key) };
}

const P = bundle.pa;
out.paExports = Object.keys(P).sort();
const K_INPUTS = ["0.03", "0,03", ".03", "3", "3.", " 0.045 ", "", "   ", "abc", "0.0.3", "-0.02", "1e-2", "0.03 ", "０.０３", "K0.03", "0.03\n"];
const GCODES = [
  "", "M900 K0.03", "M900 K.03", "M900  K0.03", "M900\tK0.03", "M900K0.03", "m900 k0.03", "M900 L1000 M10\nM900 K0.035",
  "; start\nM900 K0.02 ; pa\nG28", "G28\nM900 K0.02", "M900 K0.02\nG28", "G28", "M900 K0.02\nM900 K0.04", "M900 K", "M900 K0.02 L1000",
  "line1\nline2\n", "\nM900 K0.02\n",
];
out.readPaK = {};
for (const g of GCODES) out.readPaK[g] = call(P.readPaK, g);
out.readPaKNonString = { array: call(P.readPaK, ["M900 K0.03"]), undefined: call(P.readPaK, undefined), null: call(P.readPaK, null), number: call(P.readPaK, 5) };
out.normalizePaK = {};
for (const k of K_INPUTS) out.normalizePaK[JSON.stringify(k)] = call(P.normalizePaK, k);
out.normalizePaKNonString = { undefined: call(P.normalizePaK, undefined), number: call(P.normalizePaK, 0.03), array: call(P.normalizePaK, ["0.03"]) };
out.writePaK = {};
for (const g of GCODES) {
  out.writePaK[g] = {};
  for (const k of ["0.05", "0,05", "", "abc", " .1 "]) out.writePaK[g][JSON.stringify(k)] = call(P.writePaK, g, k);
}
out.writePaKNonString = { arrayGcode: call(P.writePaK, ["M900 K0.03"], "0.05"), undefinedGcode: call(P.writePaK, undefined, "0.05"), numberK: call(P.writePaK, "G28", 0.05) };
out.roundTrip = GCODES.map((g) => [g, call(P.readPaK, call(P.writePaK, g, "0.07"))]);

const E = bundle.err;
out.errExports = Object.keys(E).sort();
class ApiError extends Error { constructor(m) { super(m); this.status = 400; } }
out.errorMessage = [
  new Error("boom"), new ApiError("api says no"), new TypeError(""), "a string", 42, null, undefined, { message: "plain object" }, ["a", "b"], { toString: () => "custom" },
].map((v) => call(E.errorMessage, v));

console.log(JSON.stringify(out, null, 1));
