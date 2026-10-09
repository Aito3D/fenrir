// Golden probe: the Projects-PDM frontend's pure rules — the printable-file
// rule mirrored from the backend, section/status label keys, chip classes,
// the print-profile one-liner, and the drag-drop item naming helpers.
const m = require("/tmp/fenrir-refactor-probe/pdmFrontend.cjs");
const { filesUi, fileDrop } = m;

const safe = (fn) => {
  try {
    const v = fn();
    return v === undefined ? "__undefined__" : v;
  } catch (e) {
    return { __threw__: `${e && e.name}: ${e && e.message}` };
  }
};

const NAMES = [
  "support.3mf", "support.gcode.3mf", "SUPPORT.GCODE.3MF", "plate.gcode", "plate.BGCODE", "model.stl",
  "model.STEP", "scan.ply", "notes.pdf", "noext", ".3mf", " padded.3mf ", "a.b.c.3mf", "", "x.3mf.bak",
  "P-0042_support.3mf", "Pièce / principale.3mf", "weird.3MF ", "archive.tar.gz", "  spaced  name  .gcode",
];
const SECTIONS = ["scan", "modelisation", "impression", "usinage", "docs", "nope"];
const STATUSES = ["wip", "valide", "obsolete", "nope"];

const out = {};
out.constants = {
  SECTION_ORDER: filesUi.SECTION_ORDER,
  ENABLED_SECTIONS: filesUi.ENABLED_SECTIONS,
  PRINTABLE_EXTENSIONS: filesUi.PRINTABLE_EXTENSIONS,
  PRINTABLE_ACCEPT: filesUi.PRINTABLE_ACCEPT,
  SECTION_LABEL_KEYS: filesUi.SECTION_LABEL_KEYS,
  STATUS_LABEL_KEYS: filesUi.STATUS_LABEL_KEYS,
  STATUS_CHIP_CLS: filesUi.STATUS_CHIP_CLS,
  PREVIEWABLE_TYPES: filesUi.PREVIEWABLE_TYPES,
  chipBase: filesUi.chipBase,
};
out.exports = { filesUi: Object.keys(filesUi).sort(), fileDrop: Object.keys(fileDrop).sort() };
out.isSectionEnabled = Object.fromEntries(SECTIONS.map((s) => [s, safe(() => filesUi.isSectionEnabled(s))]));
out.statusLabelKey = Object.fromEntries(STATUSES.map((s) => [s, safe(() => filesUi.STATUS_LABEL_KEYS[s])]));
out.isPrintableFilename = Object.fromEntries(NAMES.map((n) => [n, safe(() => filesUi.isPrintableFilename(n))]));
out.isPrintableFile = Object.fromEntries(NAMES.map((n) => [n, safe(() => filesUi.isPrintableFile(n))]));
out.nonPrintableFiles = safe(() =>
  filesUi.nonPrintableFiles(NAMES.filter((n) => n).map((n) => new File([""], n))).map((f) => f.name),
);
const PROFILES = {
  null: null,
  empty: {},
  full: { printer_model: "Bambu Lab X1 Carbon", printer_preset: "X1C 0.4", process_preset: "0.20mm Standard", filament_presets: ["Bambu PLA Basic", "Generic PETG"], filament_types: ["PLA", "PETG"], nozzle_diameter: "0.4", layer_height: "0.2", sliced: true },
  partial: { printer_model: "P1S", layer_height: 0.28 },
  unsliced_only: { sliced: false },
  numbers: { nozzle_diameter: 0.6, layer_height: 0.12, filament_types: ["PETG"] },
  odd_types: { printer_model: 42, filament_types: "PLA", layer_height: null },
};
out.printProfileLine = Object.fromEntries(Object.entries(PROFILES).map(([k, p]) => [k, safe(() => filesUi.printProfileLine(p))]));
out.itemNameFromFile = Object.fromEntries(NAMES.map((n) => [n, safe(() => fileDrop.itemNameFromFile(n))]));
out.itemNameKey = Object.fromEntries(
  [...NAMES, "Pièce", "PIÈCE", "piece", "Straße", "STRASSE", "İstanbul", "ﬁle", "é", "é"].map((n) => [n, safe(() => fileDrop.itemNameKey(n))]),
);
process.stdout.write(JSON.stringify(out, null, 1) + "\n");
