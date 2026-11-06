// Golden probe: the Order Board's pure frontend rules, as exported today by
// frontend/src/components/orders/{orderBoard,orderStatus,orderErrors}.ts:
// accent-folded search, the brand / search / status / payment filters and their
// counts, totals and paid share, the four sorts in both directions, the finished
// list's search and payment filter, "board is ready" and the polling interval,
// age tones, quantity formatting, day parsing, days past due, the expanded
// panel's groups, what can be picked / boxed / handed over next, the lines a
// check sends, the status / payment / tone tables, and how an error is worded.
// Pure functions only, fixed inputs. The clock is pinned (daysPastDue reads
// "today") and TZ is UTC, so the output is the same at any hour of any day.
process.env.TZ = "UTC";
const RealDate = Date;
const NOW = RealDate.UTC(2026, 2, 14, 20, 30);
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length === 0) super(NOW); else super(...args); }
  static now() { return NOW; }
};
// api/client.ts reads the stored token when it loads; Node has no (working) web storage.
const store = { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
for (const k of ["localStorage", "sessionStorage"]) Object.defineProperty(globalThis, k, { value: store, configurable: true, writable: true });

const bundle = require("/tmp/fenrir-refactor-probe/ordersFrontend.cjs");
const o = bundle.orderBoard, st = bundle.orderStatus, er = bundle.orderErrors, ApiError = bundle.ApiError;

const safe = (fn) => {
  try {
    const v = fn();
    return v === undefined ? "__undefined__" : v;
  } catch (e) {
    return { __threw__: `${e && e.name}: ${e && e.message}` };
  }
};

const L = (id, state, quantity, extra = {}) => ({
  id, item_id: `I${id}`, name: `Produit ${id}`, sku: `SKU-${id}`, state, quantity,
  shipped: 0, cancelled: 0, remaining: quantity, invoiced: 0, packed_waiting: 0,
  stock_available: 0, covered: 0, packable: 0, shortfall: 0, covered_by_po: 0, po_numbers: [], ...extra,
});
const PAY = (state, extra = {}) => ({ state, pct: 0, paid: 0, invoice_paid: 0, advance: 0, due: 0, overdue: 0, rest: 0, left: 0, next_due: null, invoices: [], ...extra });
const FACTS = (extra = {}) => ({ channel: "", reference: "", delivery_method: "", payment_terms: "", shopify_url: null, quote_url: null, ...extra });
const R = (n, status, extra = {}) => ({
  id: `so${n}`, number: `SO-${String(n).padStart(5, "0")}`, customer: `Client ${n}`, customer_id: `c${n}`, date: "2026-03-01",
  total: n * 1000, currency: "XPF", status, age_days: n, is_core: n % 2 === 0, ready_ratio: (n % 4) / 4,
  packed: 0, units: { total: 1, shipped: 0, ready: 1, backordered: 0, to_order: 0 }, packages: [], picklists: [], picked: 0,
  unbilled_units: 0, prep: null, lines: [], zoho_url: null, payment: null, contact: null, facts: FACTS(), ...extra,
});

const rows = [
  R(1, "to_ship", { customer: "Lycée Agricole d'Opunohu", customer_id: "cA", payment: PAY("unpaid", { overdue: 300 }), facts: FACTS({ reference: "DEV26-2638" }), lines: [L("a", "ready", 2, { name: "Filament PLA éco", sku: "ESUN-PLA-1" })] }),
  R(2, "partial", { customer: "école Émile", customer_id: "cA", total: null, payment: PAY("partial", { paid: 400 }), lines: [L("b", "ready", 1), L("c", "backorder", 3, { name: "Cordage Marlow", sku: "MAR-8" })] }),
  R(3, "incoming", { customer: "Zoé", age_days: 46, payment: PAY("paid", { paid: 3000, pct: 100 }), facts: FACTS({ reference: "#1042" }) }),
  R(4, "to_order", { customer: "alpha", customer_id: "", age_days: 21, ready_ratio: 1, payment: PAY("partial", { paid: 1999.99, overdue: 0.01 }) }),
  R(5, "to_ship", { customer: "Émile", customer_id: "", total: 250.5, age_days: 20 }),
  R(6, "to_order", { customer: null, customer_id: "cA", age_days: 45, payment: PAY("unpaid"), lines: [L("d", "to_order", 1, { name: null, sku: null })] }),
];
const legacyRow = { ...R(7, "to_ship"), facts: undefined }; // a row from before `facts`: what the search does with it

const F = (n, extra = {}) => ({ id: `so${n}`, number: `SO-${String(n).padStart(5, "0")}`, customer: `Client ${n}`, date: "2026-02-01", total: n * 100, currency: "XPF", reference: "", paid_flag: null, payment: null, zoho_url: null, ...extra });
const finished = [
  F(1, { customer: "Lycée Agricole", reference: "#1042", paid_flag: "paid" }),
  F(2, { customer: "Zoé", paid_flag: "unpaid", payment: PAY("partial", { overdue: 50 }) }),
  F(3, { customer: null, reference: "DEV26-2638", paid_flag: "partial" }),
  F(4, { paid_flag: null }),
  F(5, { paid_flag: "paid", payment: PAY("paid") }),
  F(6, { paid_flag: "unpaid", payment: PAY("unpaid", { overdue: 0 }) }),
];

const panelRow = R(7, "partial", {
  lines: [
    L("p1", "ready", 5, { shipped: 2, remaining: 3, packed_waiting: 1 }),
    L("p2", "backorder", 2.5, { remaining: 2.5 }),
    L("p3", "to_order", 4, { remaining: 4, packed_waiting: 4 }),
    L("p4", "shipped", 3, { shipped: 3, remaining: 0 }),
    L("p5", "service", 1, { shipped: 1 }),
    L("p6", "cancelled", 2, { cancelled: 2, remaining: 0 }),
    L("p7", "ready", 0.1, { remaining: 0.1, packed_waiting: 0.03 }),
    L("p8", "ready", 0.2, { remaining: 0.2 }),
  ],
});

const B = (computed, stock, sync = {}) => ({
  rows: [], computed_at: computed, stock_loaded_at: stock,
  sync: { enabled: true, configured: true, running: false, pending: 0, last_error: null, last_error_at: null, last_success_at: null, ...sync },
});
const boards = {
  undefined: undefined,
  fresh: B(null, null),
  "stock-only": B(null, "2026-03-14T00:00:00+00:00"),
  "computed-only": B("2026-03-14T00:00:00+00:00", null),
  ready: B("2026-03-14T00:00:00+00:00", "2026-03-14T00:00:00+00:00"),
  "ready-running": B("2026-03-14T00:00:00+00:00", "2026-03-14T00:00:00+00:00", { running: true }),
  "ready-pending": B("2026-03-14T00:00:00+00:00", "2026-03-14T00:00:00+00:00", { pending: 3 }),
  "never-disabled": B(null, null, { enabled: false }),
  "never-unconfigured": B(null, null, { configured: false }),
};

const PL = (id, status) => ({ id, number: `PL-${id}`, status, date: "2026-03-10" });
const PK = (id, status) => ({ id, shipment_id: "", number: `PKG-${id}`, status, date: "2026-03-10" });
const stepRows = {
  "nothing": { lines: [], packages: [], picklists: [], picked: 0 },
  "shelf-holds-units": { lines: [L("a", "ready", 2, { packable: 1.005 }), L("b", "ready", 1, { packable: 0.335 })], packages: [], picklists: [], picked: 0 },
  "open-picklist": { lines: [L("a", "ready", 2, { packable: 2 })], packages: [PK("1", "not_shipped")], picklists: [PL("1", "completed"), PL("2", "yet_to_start")], picked: 0 },
  "completed-picklist-units-waiting": { lines: [L("a", "ready", 2)], packages: [], picklists: [PL("1", "completed")], picked: 1.5 },
  "completed-picklist-all-boxed": { lines: [L("a", "ready", 2)], packages: [PK("1", "shipped"), PK("2", "not_shipped"), PK("3", "not_shipped")], picklists: [PL("1", "completed")], picked: 0 },
  "parcel-waiting-and-shelf": { lines: [L("a", "ready", 2, { packable: 1 })], packages: [PK("9", "not_shipped")], picklists: [], picked: 0 },
  "delivered-only": { lines: [L("a", "shipped", 2)], packages: [PK("1", "delivered")], picklists: [PL("1", "completed")], picked: 0 },
  "fields-missing": { lines: [{ id: "x" }], packages: [] },
};

const t = (key, opts) => `t(${key}${opts ? " " + JSON.stringify(opts) : ""})`;
const errors = {
  "ApiError 400": new ApiError("too_many", 400),
  "ApiError 404": new ApiError("Order not found.", 404),
  "ApiError 409": new ApiError("Another action on this order is still running.", 409),
  "ApiError 422": new ApiError("Validation failed", 422),
  "ApiError 502": new ApiError("Le client est inactif.", 502),
  "ApiError 503": new ApiError("Zoho is busy, try again shortly.", 503),
  "ApiError 500 with code": new ApiError("boom", 500, "internal", { code: "internal" }),
  "Error": new Error("Failed to fetch"),
  "TypeError": new TypeError("x is not a function"),
  "string": "plain string",
  "object with status": { status: 409, message: "looks like one" },
  "null": null,
  "undefined": undefined,
};

const ids = (rs) => rs.map((r) => r.number);
const out = {
  exports: { orderBoard: Object.keys(o).sort(), orderStatus: Object.keys(st).sort(), orderErrors: Object.keys(er).sort() },
  foldText: Object.fromEntries(["LYCÉE", "Crème brûlée", "", null, undefined, "ÀÉÎÕÜ ç ñ", "ǆ ß"].map((s) => [String(s), safe(() => o.foldText(s))])),
  byBrand: { core: safe(() => ids(o.byBrand(rows, true))), all: safe(() => ids(o.byBrand(rows, false))) },
  bySearch: Object.fromEntries(["", "   ", "lycee", "LYCÉE", "emile", "so-00003", "marlow", "mar-8", "esun-pla", "zzz", " Zoe ", "dev26", "#1042", "1042"].map((q) => [JSON.stringify(q), safe(() => ids(o.bySearch(rows, q)))])),
  bySearchRowWithoutFacts: { blank: safe(() => ids(o.bySearch([legacyRow], ""))), query: safe(() => ids(o.bySearch([legacyRow], "so-"))) },
  byStatus: Object.fromEntries(["all", "to_ship", "partial", "incoming", "to_order"].map((s) => [s, safe(() => ids(o.byStatus(rows, s)))])),
  countByStatus: { rows: safe(() => o.countByStatus(rows)), empty: safe(() => o.countByStatus([])) },
  byPayment: Object.fromEntries(["all", "unpaid", "partial", "paid", "overdue", "nonsense"].map((f) => [f, safe(() => ids(o.byPayment(rows, f)))])),
  countByPayment: { rows: safe(() => o.countByPayment(rows)), empty: safe(() => o.countByPayment([])) },
  paidPct: {
    rows: safe(() => o.paidPct(rows)), empty: safe(() => o.paidPct([])), "no-payment": safe(() => o.paidPct([rows[4]])),
    "null-total-with-payment": safe(() => o.paidPct([rows[1]])), "all-paid": safe(() => o.paidPct([rows[2]])),
    "a-hair-below-full": safe(() => o.paidPct([rows[3]])), "paid-above-total": safe(() => o.paidPct([R(1, "to_ship", { payment: PAY("paid", { paid: 1500 }) })])),
  },
  otherOpenOrders: Object.fromEntries(rows.map((r) => [r.number, safe(() => ids(o.otherOpenOrders(rows, r)))])),
  finishedPayState: Object.fromEntries(finished.map((r) => [r.number, safe(() => o.finishedPayState(r))])),
  searchFinished: Object.fromEntries(["", "  ", "lycee", "so-00002", "1042", "dev26", "ZOÉ", "zzz"].map((q) => [JSON.stringify(q), safe(() => ids(o.searchFinished(finished, q)))])),
  byFinishedPayment: Object.fromEntries(["all", "unpaid", "partial", "paid", "overdue"].map((f) => [f, safe(() => ids(o.byFinishedPayment(finished, f)))])),
  totalValue: { rows: safe(() => o.totalValue(rows)), empty: safe(() => o.totalValue([])) },
  sortRows: {},
  isBoardReady: Object.fromEntries(Object.entries(boards).map(([k, b]) => [k, safe(() => o.isBoardReady(b))])),
  pollMs: Object.fromEntries(Object.entries(boards).map(([k, b]) => [k, safe(() => o.pollMs(b))])),
  ageTone: Object.fromEntries([0, 20, 21, 45, 46, 400, -1].map((d) => [d, safe(() => o.ageTone(d))])),
  formatQty: Object.fromEntries([0, 1, 1.5, 2.005, 0.1 + 0.2, 12.999, 1e6, -3.14159].map((n) => [String(n), safe(() => o.formatQty(n))])),
  parseDay: Object.fromEntries(["2026-09-12", "2026-01-01", "2026-12-31", "2026", "", "x-y-z"].map((d) => [JSON.stringify(d), safe(() => { const v = o.parseDay(d); return isNaN(v) ? "Invalid Date" : v.toISOString(); })])),
  daysPastDue: Object.fromEntries(["2026-03-14", "2026-03-13", "2026-03-15", "2026-02-14", "2027-03-14", "2026-03", "", "soon"].map((d) => [JSON.stringify(d), safe(() => { const v = o.daysPastDue(d); return Number.isNaN(v) ? "NaN" : v; })])),
  panelGroups: {
    mixed: safe(() => o.panelGroups(panelRow).map((g) => ({ id: g.id, units: g.units, lines: g.lines.map((l) => ({ line: l.line.id, qty: l.qty, ofQty: l.ofQty })) }))),
    empty: safe(() => o.panelGroups(R(8, "to_ship"))),
    searchRow: safe(() => o.panelGroups(rows[1]).map((g) => ({ id: g.id, units: g.units, n: g.lines.length }))),
  },
  packableUnits: Object.fromEntries(Object.entries(stepRows).map(([k, r]) => [k, safe(() => o.packableUnits(r))])),
  canPick: Object.fromEntries(Object.entries(stepRows).map(([k, r]) => [k, safe(() => o.canPick(r))])),
  boxablePicklists: Object.fromEntries(Object.entries(stepRows).map(([k, r]) => [k, safe(() => o.boxablePicklists(r).map((p) => p.id))])),
  waitingPackages: Object.fromEntries(Object.entries(stepRows).map(([k, r]) => [k, safe(() => o.waitingPackages(r).map((p) => p.id))])),
  nextStep: Object.fromEntries(Object.entries(stepRows).map(([k, r]) => [k, safe(() => o.nextStep(r))])),
  checkLines: {
    chosen: safe(() => o.checkLines({ max: { a: 3, b: 1.5, c: 2, d: 0 }, qty: { a: 2, b: 9, c: 0, d: 4, zzz: 7 } })),
    "nothing-chosen": safe(() => o.checkLines({ max: { a: 3 }, qty: {} })),
    fractions: safe(() => o.checkLines({ max: { a: 0.335, b: 1.005, c: 0.004 }, qty: { a: 0.335, b: 1.005, c: 0.004 } })),
    negative: safe(() => o.checkLines({ max: { a: 3 }, qty: { a: -1 } })),
    empty: safe(() => o.checkLines({ max: {}, qty: { a: 1 } })),
  },
  STATUSES: st.STATUSES,
  STATUS_META: safe(() => Object.fromEntries(Object.entries(st.STATUS_META).map(([k, v]) => [k, { ...v, icon: (v.icon && (v.icon.displayName || v.icon.name)) || "?" }]))),
  PAY_META: safe(() => Object.fromEntries(Object.entries(st.PAY_META).map(([k, v]) => [k, { ...v, icon: (v.icon && (v.icon.displayName || v.icon.name)) || "?" }]))),
  TONE: st.TONE,
  FIT_VIEWPORT: st.FIT_VIEWPORT,
  ROW_GRID: st.ROW_GRID,
  isRefused: Object.fromEntries(Object.entries(errors).map(([k, e]) => [k, safe(() => er.isRefused(e))])),
  errorReason: Object.fromEntries(Object.entries(errors).map(([k, e]) => [k, safe(() => er.errorReason(t, e))])),
  inputUntouched: null,
};
const before = JSON.stringify(rows);
for (const key of ["age", "value", "customer", "ready"]) for (const flipped of [false, true]) for (const locale of ["en", "fr"])
  out.sortRows[`${key}${flipped ? "-flipped" : ""}-${locale}`] = safe(() => ids(o.sortRows(rows, key, flipped, locale)));
out.inputUntouched = JSON.stringify(rows) === before;
console.log(JSON.stringify(out, null, 1));
