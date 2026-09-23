// Golden probe: the tracking page's pure frontend logic.
//
// What the page SAYS and WHEN it moves, without rendering it:
//
//   * `utils/aitoTracking.ts` — the language fallback, the rail's stage order
//     and labels, the status title/sub-line per column (with and without a
//     shipment, a waybill, a collection date), the ETA slot's four kinds, the
//     two date formatters, and the two motion clocks (TRACK_MOTION with its
//     node/state delay helpers, ENTRY_MOTION).
//   * `utils/trackingCode.ts` — the client-side twin of the server's
//     normalize_token: what the six squares show for what was typed.
//   * `utils/trackingShell.ts` — the brand word, the shared class strings and
//     the animation-delay helper the shell components are built from.
//
// `t` is a stub that echoes the key and its options, so the probe records
// WHICH translation the page asks for and with WHAT values — the strings
// themselves are the i18n probe's business. Clock and timezone are pinned:
// TZ=UTC by the probe command, `now`/`today` passed in explicitly.
//
// The bundle is produced by rolldown into /tmp/fenrir-refactor-probe/ by the
// probe command in PROBES.json before this script runs.
const { tracking, code, shell } = require("/tmp/fenrir-refactor-probe/trackingFrontend.cjs");

const t = (key, opts) => (opts ? `${key}|${JSON.stringify(opts)}` : key);
const NOW = new Date("2026-03-15T12:00:00.000Z");
const COLUMNS = ["devis", "waiting", "scan", "model", "print", "finish", "done", "unknown"];
const out = {};

out.fallbackLanguage = tracking.TRACKING_FALLBACK_LANGUAGE;
const supported = ["en", "fr", "de", "pt-BR", "zh-CN"];
out.defaultLanguage = {};
for (const [label, stored, navs] of [
  ["stored_supported", "de", ["en-US"]],
  ["stored_unsupported_nav_match", "xx", ["en-US"]],
  ["no_stored_exact", null, ["fr"]],
  ["no_stored_base_match", null, ["fr-PF", "ty"]],
  ["no_stored_full_tag_only", null, ["pt-BR"]],
  ["no_stored_base_of_regional", null, ["zh-TW"]],
  ["no_stored_none_match", null, ["ty", "ja-JP"]],
  ["no_stored_empty", null, []],
  ["empty_string_stored", "", ["ty"]],
]) {
  out.defaultLanguage[label] = tracking.trackingDefaultLanguage(stored, navs, supported);
}

out.stageIndex = Object.fromEntries(COLUMNS.map((c) => [c, tracking.trackStageIndex(c)]));
out.stages = { shipped: tracking.trackStages(true, t), collected: tracking.trackStages(false, t) };

out.longDate = {};
for (const lng of ["fr", "en", "de", "ja"]) {
  out.longDate[lng] = {
    day: tracking.longDate("2026-09-20", lng),
    timestamp: tracking.longDate("2026-09-20T23:30:00", lng),
    new_year_eve: tracking.longDate("2026-12-31", lng),
  };
}

out.updatedAt = {};
for (const [label, iso] of [
  ["today", "2026-03-15T09:42:00"],
  ["today_midnight", "2026-03-15T00:00:00"],
  ["yesterday", "2026-03-14T18:20:00"],
  ["yesterday_edge", "2026-03-14T23:59:59"],
  ["two_days_ago", "2026-03-13T11:05:00"],
  ["last_year", "2025-12-31T23:59:00"],
]) {
  out.updatedAt[label] = { fr: tracking.updatedAt(iso, t, "fr", NOW), en: tracking.updatedAt(iso, t, "en", NOW) };
}

const base = { tasks: [], due_date: null, shipping: null, done_at: null, invoice: null, payment: null, reference: null, updated_at: "2026-03-15T09:00:00" };
out.statusCopy = {};
for (const column of COLUMNS) out.statusCopy[column] = tracking.statusCopy({ ...base, column }, t, "fr");
out.statusCopy.done_shipped = tracking.statusCopy({ ...base, column: "done", shipping: { island: "Moorea", service: "Fret aérien", lta: null } }, t, "fr");
out.statusCopy.done_shipped_lta = tracking.statusCopy({ ...base, column: "done", shipping: { island: "Moorea", service: "Fret aérien", lta: "AWB-123" } }, t, "fr");
out.statusCopy.done_picked_up = tracking.statusCopy({ ...base, column: "done", done_at: "2026-03-01T10:00:00" }, t, "fr");
out.statusCopy.done_picked_up_en = tracking.statusCopy({ ...base, column: "done", done_at: "2026-03-01T10:00:00" }, t, "en");
out.statusCopy.done_shipped_and_dated = tracking.statusCopy({ ...base, column: "done", done_at: "2026-03-01T10:00:00", shipping: { island: "Moorea", service: "Fret aérien", lta: null } }, t, "fr");

out.etaCopy = {};
for (const column of COLUMNS) {
  for (const [label, due] of [["none", null], ["future", "2026-03-20"], ["today", "2026-03-15"], ["past", "2026-03-14"]]) {
    out.etaCopy[`${column}/${label}`] = tracking.etaCopy({ ...base, column, due_date: due }, t, "fr", NOW);
  }
}

out.motion = {
  TRACK_MOTION: tracking.TRACK_MOTION,
  ENTRY_MOTION: tracking.ENTRY_MOTION,
  nodeDelay: [0, 1, 2, 6].map((i) => [i, tracking.trackNodeDelay(i), tracking.trackNodeDelay(i, 3)]),
  stateDelay: [0, 3, 6].map((i) => [i, tracking.trackStateDelay(i), tracking.trackStateDelay(i, 2)]),
};

out.code = {
  CODE_LENGTH: code.CODE_LENGTH,
  normalize: Object.fromEntries(
    ["K7F3XQ", "k7f3xq", "k7f-3xq", " K7F 3XQ ", "kof3lq", "KIF3XQ", "K7F3X", "K7F3XQ9W", "K7F3XU", "K7F3X!", "", "u-u-u", "k7f3xq\n123", "ilo"].map((raw) => [
      JSON.stringify(raw),
      code.normalizeCode(raw),
    ]),
  ),
};

out.shell = { BRAND: shell.BRAND, CARD: shell.CARD, FOCUS: shell.FOCUS, PRESS: shell.PRESS, delayAt: [shell.delayAt(0), shell.delayAt(260)] };

console.log(JSON.stringify(out, null, 2));
