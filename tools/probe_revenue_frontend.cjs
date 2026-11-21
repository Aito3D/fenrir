// Golden probe (RV1): the Revenue page's pure UI modules (components/revenue/lib/*) on fixed inputs —
// calendar arithmetic, bucket keys/labels/ranges, window shift and drill-down, pace series, the
// copy-paste summary, chart splits/series/stacks/ticks, margin re-cut, CSV, query strings and file
// names, poll/banner/ready rules, the series loader (ETag + stale handling) and poller on fake
// fetch/timers, stored-control restore, URL round trip, findings, number formats, calendar layout,
// KPI and insight tiles, product search/brand filters, basket.
// `t` echoes the key, so the probe records WHICH translation is asked for. Clock pinned to
// 2026-03-11T20:00:00Z, TZ=Pacific/Tahiti set by the probe command.
const FIXED = Date.parse("2026-03-11T20:00:00Z");
const RealDate = Date;
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [FIXED])); } static now() { return FIXED; } };
const L = require("/tmp/fenrir-revenue-probe/revenueFrontend.cjs");

const t = (key) => `t(${key})`;
const call = (fn, ...args) => {
  try { const v = fn(...args); return v === undefined ? "__undefined__" : v instanceof Set ? { __set__: [...v] } : v; }
  catch (e) { return { __threw__: `${e.name}: ${e.message}` }; }
};
const out = {};
for (const [name, mod] of Object.entries(L)) out[`exports.${name}`] = Object.keys(mod).sort();

const GR = ["day", "week", "month", "year"];
const DAYS = ["2024-01-01", "2025-12-29", "2026-01-01", "2026-02-28", "2026-03-11", "2026-12-31"];

// --- dates / buckets -----------------------------------------------------------------
const D = L.dates;
out.dates = {
  DAY_MS: D.DAY_MS, REVENUE_HISTORY_START: D.REVENUE_HISTORY_START,
  orgToday: [call(D.orgToday), call(D.orgToday, new RealDate("2026-03-11T09:59:00Z")), call(D.orgToday, new RealDate("2026-03-11T10:00:00Z"))],
  isValidDay: ["2026-02-28", "2026-02-29", "2024-02-29", "2026-1-01", "x", ""].map((d) => call(D.isValidDay, d)),
  dayToUtc: ["2026-03-11", "1970-01-01", "bad"].map((d) => call(D.dayToUtc, d)),
  utcToDay: [0, 1773187200000, 1773273599999].map((m) => call(D.utcToDay, m)),
  addDays: [-60, -1, 0, 1, 2, 365].map((n) => call(D.addDays, "2026-02-27", n)),
  allDays: call(D.allDays, "2024-02-27", "2024-03-02"),
  daysBetween: [["2026-01-01", "2026-03-11"], ["2026-03-11", "2026-01-01"], ["2024-02-28", "2024-03-01"]].map(([a, b]) => call(D.daysBetween, a, b)),
  daysInMonth: [[2024, 2], [2026, 2], [2026, 12], [2026, 4]].map(([y, m]) => call(D.daysInMonth, y, m)),
  isoWeek: ["2026-01-01", "2025-12-29", "2027-01-03", "2026-03-11", "2020-12-31"].map((d) => call(D.isoWeek, d)),
  isoWeek1Monday: [2020, 2025, 2026, 2027].map((y) => call(D.isoWeek1Monday, y)),
};
const B = L.buckets;
out.buckets = { RANGE_PRESETS: B.RANGE_PRESETS };
for (const g of GR) {
  const keys = [...new Set(DAYS.map((d) => B.bucketKeyFor(d, g)))];
  out.buckets[g] = {
    keyFor: DAYS.map((d) => call(B.bucketKeyFor, d, g)),
    range: keys.map((k) => call(B.bucketRange, k, g)),
    label: keys.map((k) => call(B.bucketLabel, k, g)),
    shiftYear: keys.map((k) => [call(B.shiftBucketYear, k, g, -1), call(B.shiftBucketYear, k, g, 1)]),
    isKey: ["2026", "2026-03", "2026-03-11", "2026-W10", "2026-W53", "2026-13", "x"].map((k) => call(B.isBucketKey, k, g)),
    shiftKey: keys.map((k) => [-13, -1, 1, 2].map((n) => call(L.analysis.shiftBucketKey, k, g, n))),
    shiftWindow: [-1, 1, 3].map((n) => call(L.analysis.shiftWindow, "2025-11-15", "2026-02-10", g, n, "2024-01-01", "2026-03-11")),
    drillDown: call(L.analysis.drillDown, { start: "2026-03-01", end: "2026-03-31" }, g),
  };
}

// --- a realistic run of buckets ----------------------------------------------------------
const bucket = (o) => ({
  key: "2026-10", label: "oct. 2026", start: "2026-10-01", end: "2026-10-31", ht: 0, ttc: 0, goods: 0, services: 0, byNature: {}, byBrand: {},
  goodsTtc: 0, servicesTtc: 0, byNatureTtc: {}, byBrandTtc: {}, bySegment: {}, bySegmentTtc: {}, cost: 0, costedHt: 0, projection: null,
  projectionMethod: null, quantity: 0, evolution: { ht: null, ttc: null }, yearAgo: null, elapsedDays: null, cumulative: { ht: 0, ttc: 0 },
  partial: false, missingDays: 0, ttcApprox: false, ...o,
});
const NAT = ["Filaments", "3D Printers", "Sans nature", "3D Printer Accessories", "3D Printer Adhesives", "Boats", "3D Printer Replacement Parts"];
const BR = ["SUNLU", "Bambu Lab", "Aito3D", "Sans marque", "eSUN", "Polymaker", "Magigoo"];
const mk = (i, key, label, start, end, ht, o = {}) => {
  const split = (names, total) => Object.fromEntries(names.map((n, j) => [n, j === names.length - 1 ? -Math.round(total * 0.02) : Math.round(total / (j + 2) / 1.6)]));
  return bucket({
    key, label, start, end, ht, ttc: Math.round(ht * 1.15), goods: Math.round(ht * 0.7), services: ht - Math.round(ht * 0.7),
    goodsTtc: Math.round(ht * 0.7 * 1.16), servicesTtc: Math.round((ht - Math.round(ht * 0.7)) * 1.13),
    byNature: split(NAT.slice(0, 3 + i), ht), byNatureTtc: split(NAT.slice(0, 3 + i), ht * 1.15), byBrand: split(BR.slice(0, 3 + i), ht), byBrandTtc: split(BR.slice(0, 3 + i), ht * 1.15),
    bySegment: { pro: Math.round(ht * 0.5), particulier: Math.round(ht * 0.3), passage: Math.round(ht * 0.15), inconnu: ht - Math.round(ht * 0.95) },
    bySegmentTtc: { pro: Math.round(ht * 0.575), inconnu: 10 },
    cost: Math.round(ht * 0.45), costedHt: Math.round(ht * 0.8), costParts: { items: Math.round(ht * 0.4), filament: 100, energy: 20 }, printHours: i ? 12.5 * i : null,
    marginSplit: { nature: { Filaments: 300 * i, "Sans nature": -40 }, brand: { SUNLU: 200 }, segment: { pro: 100 }, kind: { Biens: 250, Services: 50 } },
    quantity: 10 * (i + 1), evolution: i ? { ht: 0.1 * i - 0.15, ttc: 0.1 * i - 0.14 } : { ht: null, ttc: null },
    yearAgo: i === 1 ? null : { ht: Math.round(ht * 0.8), ttc: Math.round(ht * 0.92) }, cumulative: { ht: ht * (i + 1), ttc: Math.round(ht * 1.15) * (i + 1) },
    ...o,
  });
};
const RUN = [
  mk(0, "2025-12", "déc. 2025", "2025-12-01", "2025-12-31", 250000, { previousTotal: { ht: 90000, ttc: 103000 }, target: 200000 }),
  mk(1, "2026-01", "janv. 2026", "2026-01-01", "2026-01-31", 62400, { target: 50000, ttcApprox: true }),
  mk(2, "2026-02", "févr. 2026", "2026-02-01", "2026-02-28", 6700, { missingDays: 2 }),
  mk(3, "2026-03", "mars 2026", "2026-03-01", "2026-03-31", 6900, { partial: true, elapsedDays: 11, missingDays: 5, target: 20000, projection: { ht: 19445, ttc: 22361 }, projectionMethod: "seasonal", byItem: { pla: 2400, print: 4500 }, byItemTtc: { pla: 2784, print: 5085 } }),
];
const STRIPPED = RUN.map(({ bySegment, bySegmentTtc, cost, costedHt, costParts, printHours, marginSplit, ...b }) => b);
const C = L.chart;
out.chart = { SEGMENT_LABEL: C.SEGMENT_LABEL, OTHER_SERIES: C.OTHER_SERIES, STACK_DIMENSIONS: C.STACK_DIMENSIONS, dims: {} };
for (const dim of ["nature", "brand", "kind", "segment", "item"]) {
  for (const mode of ["ht", "ttc"]) {
    const series = C.chartSeries(RUN, dim);
    const cols = C.stackColumns(RUN, series, dim, mode);
    out.chart.dims[`${dim}/${mode}`] = { split: RUN.map((b) => call(C.bucketSplit, b, dim, mode)), series, cols, scale: call(C.cumulativeScale, cols) };
  }
}
out.chart.strippedSegment = call(C.bucketSplit, STRIPPED[0], "segment", "ht");
out.chart.marginBuckets = call(C.marginBuckets, RUN, "Marge");
out.chart.marginBucketsStripped = call(C.marginBuckets, STRIPPED, "Marge");
out.chart.yFor = [[0, 0, 100, 10, 200], [50, 0, 100, 10, 200], [-20, -40, 100, 0, 100], [5, 5, 5, 0, 100]].map((a) => call(C.yFor, ...a));
out.chart.niceTicks = [0, -5, 1, 7, 99, 100, 101, 2500, 333333, 1e7].map((m) => call(C.niceTicks, m));
out.chart.cumulativeScale = [[], [{ cumulative: -50 }, { cumulative: 0.5 }]].map((c) => call(C.cumulativeScale, c));

// --- analysis / kpis / csv / finding / insights --------------------------------------------
const A = L.analysis;
const cal = (month, n, base, stop = 99) => Array.from({ length: n }, (_, i) => ({ day: `${month}-${String(i + 1).padStart(2, "0")}`, ht: base * ((i % 3) + 1), ttc: Math.round(base * ((i % 3) + 1) * 1.15), fetched: i + 1 < stop }));
out.analysis = {
  pace: [["ht", 20000], ["ttc", 20000], ["ht", null]].map(([mode, target]) => call(A.paceSeries, "2026-03", cal("2026-03", 11, 300, 10), cal("2025-03", 31, 250), mode, target)),
  paceFeb: call(A.paceSeries, "2024-02", cal("2024-02", 29, 100), [], "ht", 1000),
  summary: ["ht", "ttc"].map((mode) => call(A.summaryText, RUN, mode, { money: L.format.formatFcp, pct: L.format.formatPct }, mode === "ht" ? "SUNLU" : "")),
  summaryEmpty: call(A.summaryText, [], "ht", { money: String, pct: String }),
  summaryPlain: call(A.summaryText, [bucket({ ht: 10, ttc: 12, cost: undefined, costedHt: undefined })], "ht", { money: String, pct: String }),
};
const K = L.kpis;
out.kpis = {
  evolutionFor: RUN.map((b) => [call(K.evolutionFor, b, "ht"), call(K.evolutionFor, b, "ttc")]),
  yearOverYear: RUN.map((b) => [call(K.yearOverYear, b, "ht"), call(K.yearOverYear, b, "ttc")]),
  unitsLabel: [0, 1, -1, 2, 1.5].map((n) => call(K.unitsLabel, n)),
  kpiTiles: {},
  insightTiles: {},
};
for (const g of GR) for (const mode of ["ht", "ttc"]) for (const sel of [0, 2]) out.kpis.kpiTiles[`${g}/${mode}/${sel}`] = call(K.kpiTiles, g === "month" ? RUN : RUN.map((b) => ({ ...b, key: B.bucketKeyFor(b.start, g) })), mode, g, sel, "Mois");
out.kpis.kpiTiles.empty = call(K.kpiTiles, [], "ht", "month", 0, "Mois");
out.kpis.kpiTiles.one = call(K.kpiTiles, RUN.slice(0, 1), "ht", "month", 0, "Mois");
out.kpis.kpiTiles.stripped = call(K.kpiTiles, STRIPPED, "ht", "month", 0, "Mois");
for (const mode of ["ht", "ttc"]) out.kpis.insightTiles[mode] = call(K.insightTiles, RUN, mode, "Mois");
out.kpis.insightTiles.stripped = call(K.insightTiles, STRIPPED, "ht", "Mois");
out.kpis.insightTiles.empty = call(K.insightTiles, [], "ht", "Mois");
out.toDateRangeLabel = GR.flatMap((g) => ["previous", "year-ago"].map((against) => call(B.toDateRangeLabel, RUN[3], g, against)))
  .concat([call(B.toDateRangeLabel, { ...RUN[3], elapsedDays: 1 }, "month", "previous"), call(B.toDateRangeLabel, { ...RUN[3], elapsedDays: null }, "month", "previous"),
    call(B.toDateRangeLabel, { ...RUN[2], key: "2024-02", start: "2024-02-01", end: "2024-02-29", elapsedDays: 29 }, "month", "year-ago")]);
out.csv = { full: call(L.csv.toCsv, RUN), stripped: call(L.csv.toCsv, STRIPPED), empty: call(L.csv.toCsv, []) };
const F = L.finding;
out.finding = {
  isLevel: [0, 0.0049, -0.005, 0.005, 1].map((v) => call(F.isLevel, v)),
  asDelta: [null, 0, 0.004, 0.2, -0.3].map((v) => call(F.asDelta, v)),
  findingCase: [[null, null], [0.5, null], [0.5, 0.1], [0.5, -0.1], [0.5, 0.001], [null, 0.1], [null, -0.1], [null, 0]].map(([s, c]) => call(F.findingCase, s, c)),
};
out.calendarLayout = [call(L.insights.calendarLayout, cal("2026-02", 28, 100, 20)), call(L.insights.calendarLayout, cal("2026-03", 11, 50)), call(L.insights.calendarLayout, [])];

// --- format / search / products / basket ------------------------------------------------------
const FM = L.format;
const NUMS = [0, 0.4, 0.5, -0.5, 1, 999, 1000, 1234.5, -1234.5, 1e6, 12345678.9, -999999];
out.format = {
  formatFcp: NUMS.map(FM.formatFcp), formatAmount: NUMS.map(FM.formatAmount), compactAxis: NUMS.map(FM.compactAxis),
  formatPct: [null, 0, 0.1234, -0.05, 1, 1.5, -2.345, 0.00049].map(FM.formatPct),
  serverLabel: ["Sans marque", "Sans nature", "SUNLU", ""].map((n) => FM.serverLabel(n, t)),
};
const S = L.search;
const m = S.createSearchMatcher("pla sun");
out.search = {
  escapeRegex: ["a.b*c", "(x)[y]{z}", "^$|\\?+"].map(S.escapeRegex),
  matcher: [["SUNLU PLA", null], ["PLA", "SUN-1"], ["Sunlü PLA+", ""], ["PETG", "SUNLU"], [undefined, undefined]].map((h) => m(...h)),
  matcherAccents: ["Écolé", "ecole"].map((q) => S.createSearchMatcher(q)("ÉCOLE Gauguin")),
  matcherEmpty: S.createSearchMatcher("   ")("anything"),
};
const P = L.products;
const PRODUCTS = [
  { itemId: "pla", name: "SUNLU PLA", sku: "PLA-1", brand: "SUNLU", nature: "Filaments", totalHt: 12000, quantity: 10, lastDay: "2026-03-11", kind: "goods", reason: "nature" },
  { itemId: "petg", name: "SUNLU PETG", sku: "PETG-1", brand: " sunlu ", nature: "Filaments", totalHt: 3000, quantity: 3, lastDay: "2026-03-01", kind: "goods", reason: "nature" },
  { itemId: "x1", name: "Bambu X1C", sku: "X1C", brand: "Bambu Lab", nature: null, totalHt: 180000, quantity: 1, lastDay: "2025-12-30", kind: "goods", reason: "brand" },
  { itemId: "print", name: "Impression 3D", sku: "SRV", brand: "Aito3D", nature: null, totalHt: 13500, quantity: 4, lastDay: "2026-03-10", kind: "services", reason: "brand" },
  { itemId: "refund", name: "Avoir PLA", sku: "", brand: "Aito3D", nature: null, totalHt: -14000, quantity: -1, lastDay: "2026-03-02", kind: "goods", reason: "decision-include" },
  { itemId: "nobrand", name: "Mystery PLA", sku: "MB", brand: null, nature: null, totalHt: 50, quantity: 1, lastDay: "2026-03-03", kind: "goods", reason: "decision-include" },
];
const opts = P.brandOptions(PRODUCTS);
out.products = {
  ITEM_ID_RE: String(P.ITEM_ID_RE), MAX_SHOWN_MATCHES: P.MAX_SHOWN_MATCHES,
  idOk: ["pla", "a_b-C9", "bad id", "", "x".repeat(64), "x".repeat(65)].map((s) => P.ITEM_ID_RE.test(s)),
  brandKey: ["SUNLU", " sunlu ", null, undefined, "Bambu Lab"].map(P.brandKey),
  brandOptions: opts,
  pickedBrandChips: call(P.pickedBrandChips, new Set(["sunlu", "gone brand"]), opts),
  search: [["", new Set()], ["p", new Set()], ["pla", new Set()], ["pla", new Set(["pla"])], ["sunlu p", new Set()], ["SRV", new Set()]].map(([q, b]) => call(P.searchProducts, PRODUCTS, q, b, 2)),
  searchNull: call(P.searchProducts, null, "pla", new Set()),
  byBrands: [new Set(), new Set(["sunlu"]), new Set(["aito3d", "bambu lab"])].map((b) => call(P.filterByBrands, PRODUCTS, b)?.map?.((p) => p.itemId) ?? null),
  byBrandsNull: call(P.filterByBrands, null, new Set(["x"])),
  byKind: [null, "goods", "services"].map((k) => call(P.filterByKind, PRODUCTS, k)?.map?.((p) => p.itemId) ?? null),
  brandFilterLabel: [[], [{ brand: "SUNLU" }], [{ brand: "SUNLU" }, { brand: "Aito3D" }], [{ brand: "a" }, { brand: "b" }, { brand: "c" }]].map((p) => call(P.brandFilterLabel, p)),
};
const BK = L.basket;
const ab = BK.addToBasket([], PRODUCTS.slice(0, 2));
out.basket = {
  first: ab, again: BK.addToBasket(ab.basket, [PRODUCTS[1], PRODUCTS[2], PRODUCTS[2]]), none: BK.addToBasket(ab.basket, [PRODUCTS[0]]).basket === ab.basket,
  effectiveStack: [[0, "item"], [2, "nature"], [2, "item"], [0, "segment", false, true], [0, "kind", true], [3, "kind", true, false], [3, "segment", false, true]].map((a) => call(BK.effectiveStack, ...a)),
};

// --- dashboard / url ---------------------------------------------------------------------------------
const DB = L.dashboard;
const sync = (o) => ({ running: false, fetchedDays: 800, totalDays: 801, missingDays: 1, backfilling: false, legacyDays: 0, lastBatchAt: null, lastError: null, failedDays: [], failedCount: 0, ...o });
out.dashboard = {
  REVENUE_POLL: DB.REVENUE_POLL, REVENUE_STORAGE_KEYS: DB.REVENUE_STORAGE_KEYS, REVENUE_VIEWS: DB.REVENUE_VIEWS,
  guards: [null, "day", "month", "goods", "services", "pro", "inconnu", "clients", "evolution", "x", 3].map((v) => [v, DB.isRevenueGranularity(v), DB.isRevenueKind(v), DB.isCustomerSegment(v), DB.isRevenueView(v)]),
  filterQuery: [[null, null], [[], []], [["a", "b"], ["SUNLU", "Bambu Lab", "a&b"], "goods", "pro"], [["x"], new Set(["é"]), null, "passage"]].map((a) => call(DB.filterQuery, ...a)),
  seriesQuery: [
    { granularity: "month", range: { preset: "default" }, basketIds: [] },
    { granularity: "day", range: { preset: "custom", from: "2026-03-01", to: "2026-03-11" }, basketIds: ["pla"], brands: ["SUNLU"], kind: "services", segment: "pro" },
    { granularity: "year", range: { preset: "last-12-months" }, basketIds: [] },
  ].map((a) => call(DB.seriesQuery, a)),
  csvFileName: [["month", "2025-01-01", "2026-03-11", 0], ["day", "2026-03-01", "2026-03-11", 2, true, "goods", "pro"], ["week", "a", "b", 0, false, "services", null]].map((a) => call(DB.csvFileName, ...a)),
  pollActive: [[sync({}), "x"], [sync({ backfilling: true }), "x"], [sync({ running: true }), "x"], [sync({}), null]].map((a) => call(DB.pollActive, ...a)),
  nextPollDelay: [[true, false], [false, false], [true, true]].map(([a, h]) => call(DB.nextPollDelay, a, h, DB.REVENUE_POLL)),
  dashboardReady: [null, { sync: { fetchedDays: 0 }, itemsSyncedAt: "x" }, { sync: { fetchedDays: 3 }, itemsSyncedAt: null }, { sync: { fetchedDays: 3 }, itemsSyncedAt: "x" }].map((d) => call(DB.dashboardReady, d)),
  failureMessage: [[500, { detail: "boom" }], [502, { detail: "" }], [404, null], [403, "text"], [422, { detail: [{ msg: "x" }] }]].map(([s, b]) => call(DB.failureMessage, s, b)),
  bannerState: [sync({}), sync({ backfilling: true, fetchedDays: 400 }), sync({ running: true, fetchedDays: 801 }), sync({ lastError: "Zoho down" }), sync({ running: true, totalDays: 0, fetchedDays: 0 })].map((s) => call(DB.bannerState, s)),
  withId: [...DB.withId("b")(new Set(["a"]))], withoutId: [...DB.withoutId("a")(new Set(["a", "b"]))],
  toggleInSet: [[...DB.toggleInSet(new Set(["a"]), "a")], [...DB.toggleInSet(new Set(["a"]), "b")]],
  ids: [DB.segmentTabId("rv", "pro"), DB.segmentPanelId("rv", "pro")],
  restore: [{}, { "revenue-granularity": "week", "revenue-tax-mode": "ttc", "revenue-stack": "brand", "revenue-range": "all", "revenue-kind": "services", "revenue-segment": "pro", "revenue-view": "saison" },
    { "revenue-granularity": "hour", "revenue-tax-mode": "x", "revenue-stack": "item", "revenue-range": "custom", "revenue-kind": "x", "revenue-segment": "x", "revenue-view": "x" }].map((s) => call(DB.restoreStoredControls, (k) => (k in s ? s[k] : null))),
  storedRangeValue: [{ preset: "default" }, { preset: "custom", from: "a", to: "b" }, { preset: "this-year" }].map((c) => call(DB.storedRangeValue, c)),
  shouldFetchProducts: [[null, { fetchedDays: undefined, reviewCount: undefined }, false], [{ fetchedDays: undefined, reviewCount: undefined }, { fetchedDays: 3, reviewCount: 0 }, true],
    [{ fetchedDays: undefined, reviewCount: undefined }, { fetchedDays: 3, reviewCount: 0 }, false], [{ fetchedDays: 3, reviewCount: 0 }, { fetchedDays: 4, reviewCount: 0 }, true]].map((a) => call(DB.shouldFetchProducts, ...a)),
};
const U = L.url;
const SEARCHES = ["", "?g=week&tax=ttc&stack=brand&preset=all&kind=goods&segment=pro&view=clients&brand=SUNLU&brand=sunlu&items=pla,x1,pla",
  "?from=2026-03-01&to=2026-03-11&preset=all", "?from=2026-03-11&to=2026-03-01&preset=this-year", "?g=hour&tax=x&stack=x&kind=x&segment=x&view=x&items=bad%20id&brand=" + "x".repeat(200),
  "?" + Array.from({ length: 51 }, (_, i) => `brand=b${i}`).join("&")];
out.url = {
  from: SEARCHES.map((s) => call(U.controlsFromSearch, s)),
  to: [
    { granularity: "month", taxMode: "ht", stack: "nature", range: { preset: "default" }, kind: null, segment: null, view: "evolution", brands: [], items: [] },
    { granularity: "day", taxMode: "ttc", stack: "item", range: { preset: "custom", from: "2026-03-01", to: "2026-03-11" }, kind: "services", segment: "passage", view: "produits", brands: new Set(["sunlu", "bambu lab"]), items: ["pla", "x1"] },
    { granularity: "year", taxMode: "ht", stack: "nature", range: { preset: "this-year" }, kind: null, segment: null, view: "evolution", brands: [], items: [] },
  ].map((c) => call(U.controlsToSearch, c)),
};

// --- async: series loader on a fake fetch, poller on fake timers -------------------------------------
(async () => {
  const log = [];
  const answers = [
    { status: 200, body: { a: 1 }, etag: '"e1"' }, { status: 304 }, { status: 200, body: { a: 2 }, etag: null }, { status: 500, body: { detail: "boom" } },
    { status: 502, text: "<html>" }, { status: 200, body: { a: 3 }, etag: '"e3"' },
  ];
  let i = 0;
  const fakeFetch = async (url, init) => {
    log.push({ url, headers: init.headers });
    const a = answers[i++];
    return { status: a.status, ok: a.status >= 200 && a.status < 300, headers: { get: (k) => (k === "etag" ? a.etag ?? null : null) }, json: async () => { if (a.text) throw new SyntaxError("bad json"); return a.body; } };
  };
  const loader = DB.createSeriesLoader(() => ({ Authorization: "Bearer T" }), fakeFetch);
  const results = [];
  for (const url of ["/u1", "/u1", "/u1", "/u1", "/u1", "/u2"]) {
    try { results.push(await loader.load(url)); } catch (e) { results.push({ threw: e.message }); }
  }
  loader.reset();
  // Overtaken request: a slow first answer resolves after a second load started.
  let release;
  const slow = DB.createSeriesLoader(() => ({}), (url) => (url === "/slow" ? new Promise((r) => { release = () => r({ status: 200, ok: true, headers: { get: () => null }, json: async () => ({ s: 1 }) }); }) : Promise.resolve({ status: 200, ok: true, headers: { get: () => null }, json: async () => ({ f: 1 }) })));
  const p1 = slow.load("/slow");
  const p2 = slow.load("/fast");
  release();
  out.seriesLoader = { results, requests: log, overtaken: [await p1, await p2] };

  const events = [];
  const timers = [];
  let active = true;
  let hidden = false;
  let vis = null;
  let n = 0;
  const poller = DB.startSeriesPoller({
    load: async () => { n += 1; events.push(`load#${n}`); if (n === 2) throw new Error("x"); },
    isActive: () => active, isHidden: () => hidden, onVisibility: (h) => { vis = h; return () => events.push("unsubscribed"); },
    poll: DB.REVENUE_POLL, setTimeout: (fn, ms) => { timers.push({ fn, ms }); events.push(`arm ${ms}`); return timers.length; }, clearTimeout: (id) => events.push(`clear ${id}`),
  });
  const flush = () => new Promise((r) => setImmediate(r));
  await flush();
  await timers.at(-1).fn(); await flush();
  active = false; await timers.at(-1).fn(); await flush();
  hidden = true; await timers.at(-1).fn(); await flush();
  hidden = false; vis(); await flush();
  poller.stop();
  out.poller = events;

  console.log(JSON.stringify(out, null, 1));
})();
