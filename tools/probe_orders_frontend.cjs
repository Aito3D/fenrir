// Golden probe (O3): the Order Board UI's pure modules on fixed inputs — the list filters,
// counts, sorts, panel groups, pick/pack checks, scan, next step, line edit and parcel edit
// (orderBoard.ts); status/pay/tone tables (orderStatus.ts); refusal → message mapping
// (orderErrors.ts); event sentence + detail line per kind (orderEventKinds.ts); the public
// tracking page's copy, rail and tally (utils/orderTracking.ts).
// `t` echoes the key and its options, so the probe records WHICH translation is asked for
// with WHAT values (the strings are the i18n probe's business). Clock pinned to
// 2026-11-10T22:00:00Z, TZ=Pacific/Tahiti set by the probe command.
const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() }; };
for (const name of ["localStorage", "sessionStorage"]) Object.defineProperty(globalThis, name, { value: store(), configurable: true, writable: true });
const FIXED = Date.parse("2026-11-10T22:00:00Z");
const RealDate = Date;
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [FIXED])); } static now() { return FIXED; } };
const B = require("/tmp/fenrir-orders-probe/ordersFrontend.cjs");

const t = (key, opts) => (opts ? `${key}|${JSON.stringify(opts)}` : key);
const iconName = (i) => (i ? i.displayName || i.name || String(i) : i);
const call = (fn, ...args) => {
  try { const v = fn(...args); return v === undefined ? "__undefined__" : v; }
  catch (e) { return { __threw__: `${e.name}: ${e.message}` }; }
};
const ids = (rows) => rows.map((r) => r.id);
const out = {};

const line = (id, o = {}) => ({
  id, item_id: o.item_id ?? `i-${id}`, name: o.name ?? `Thing ${id}`, sku: o.sku ?? `SKU-${id}`, codes: o.codes ?? [`SKU-${id}`, `EAN${id}`],
  state: o.state ?? "ready", quantity: o.quantity ?? 2, shipped: o.shipped ?? 0, cancelled: o.cancelled ?? 0, remaining: o.remaining ?? (o.quantity ?? 2) - (o.shipped ?? 0),
  invoiced: 0, packed_waiting: o.packed_waiting ?? 0, stock_available: 5, covered: 2, packable: o.packable ?? 0, shortfall: o.shortfall ?? 0,
  covered_by_po: 0, po_numbers: [], rate: o.rate ?? 1000, floor: 0,
});
const pay = (state, paid, overdue = 0) => ({ state, pct: 0, paid, invoice_paid: paid, retainer: 0, advance: 0, due: 0, overdue, rest: 0, left: 0, next_due: null, invoices: [{ id: "inv1", number: "INV-0042", date: "2026-11-01", due_date: "2026-11-05", total: 100, balance: 0, status: "paid", url: null }] });
const row = (id, o = {}) => ({
  id, number: o.number ?? `SO-${id}`, customer: o.customer ?? `Customer ${id}`, date: o.date ?? "2026-11-01", total: o.total ?? 1000, currency: "XPF",
  status: o.status ?? "to_ship", age_days: o.age ?? 5, is_core: o.is_core ?? true, ready_ratio: o.ready ?? 1, packed: 0,
  units: { total: 2, shipped: 0, ready: 2, backordered: 0, to_order: o.to_order ?? 0 }, packages: o.packages ?? [], picklists: o.picklists ?? [], picked: o.picked ?? 0,
  unbilled_units: 0, prep: null, contacted: null, lines: o.lines ?? [line(`${id}a`, { packable: 2 })], zoho_url: null, customer_id: o.customer_id ?? `c-${id}`,
  payment: o.payment === undefined ? pay("unpaid", 0) : o.payment, contact: o.contact === undefined ? { name: `Hina ${id}`, email: `hina${id}@example.test`, phone: `+689 87.12.34.5${id}`, mobile: id === "4" ? "89 00 11 22" : "" } : o.contact,
  facts: { channel: "", reference: o.reference ?? "", shopify_order: "", quote_number: "", delivery_method: "", payment_terms: "", shopify_url: null, quote_url: null },
  version: o.version ?? "v1", estimable: o.estimable ?? true,
});
const rows = [
  row("1", { customer: "Lycée Gauguin", age: 50, total: 5000, status: "to_ship", payment: pay("paid", 5000), reference: "PO-77" }),
  row("2", { customer: "Ãrii Moana", age: 21, total: 3000, status: "partial", to_order: 1, ready: 0.5, payment: pay("partial", 1000, 400), customer_id: "c-1", is_core: false }),
  row("3", { customer: "zeta shop", age: 3, total: null, status: "incoming", payment: null, packages: [{ id: "pk3", shipment_id: "", number: "PKG-00003", status: "not_shipped", date: "2026-11-02" }] }),
  row("4", { customer: "Beta", age: 10, total: 800, status: "to_order", ready: 0, customer_id: "c-1", picklists: [{ id: "pl4", number: "PL-00004", status: "in_progress", date: "2026-11-03" }] }),
  row("5", { contact: null, customer: "alpha", age: 10, total: 800, status: "to_ship", picklists: [{ id: "pl5", number: "PL-00005", status: "completed", date: "2026-11-03" }], picked: 1, lines: [line("5a", { packable: 0 })] }),
];
const finished = [
  { id: "f1", number: "SO-F1", customer: "Lycée", date: "2026-09-01", total: 100, currency: "XPF", reference: "#1079", units: { shipped: 1, total: 1 }, paid_flag: "paid", payment: null, is_core: null, zoho_url: null, handed_over: "2026-10-01" },
  { id: "f2", number: "SO-F2", customer: "Other", date: "2026-11-01", total: 50, currency: "XPF", reference: "", units: { shipped: 1, total: 1 }, paid_flag: null, payment: pay("partial", 10, 5), is_core: false, zoho_url: null, handed_over: "2026-11-04" },
  { id: "f3", number: "SO-F3", customer: "Third", date: "2026-05-01", total: 70, currency: "XPF", reference: "", units: { shipped: 1, total: 1 }, paid_flag: "unpaid", payment: null, is_core: true, zoho_url: null, handed_over: null },
];

const b = B.board;
out.boardExports = Object.keys(b).sort();
out.foldText = ["LYCÉE Gauguin", "Ãrii", "", null, undefined].map((s) => call(b.foldText, s));
out.byBrand = { core: ids(b.byBrand(rows, true)), all: ids(b.byBrand(rows, false)) };
out.finishedByBrand = { core: ids(b.finishedByBrand(finished, true)), all: ids(b.finishedByBrand(finished, false)) };
out.bySearch = Object.fromEntries(["", "  ", "lycee", "PKG-00003", "inv-0042", "87 12 34", "8712", "+689", "hina@", "hina3@", "87 12 34 53", "89.00.11", "891", "thing 2a", "sku-1a", "po-77", "nope"].map((q) => [q, ids(b.bySearch(rows, q))]));
out.byStatus = Object.fromEntries(["all", "to_ship", "partial", "incoming", "to_order", "finished"].map((s) => [s, ids(b.byStatus(rows, s))]));
out.countByStatus = b.countByStatus(rows);
out.byPayment = Object.fromEntries(["all", "unpaid", "partial", "paid", "overdue"].map((s) => [s, ids(b.byPayment(rows, s))]));
out.countByPayment = b.countByPayment(rows);
out.paidPct = [call(b.paidPct, rows), call(b.paidPct, []), call(b.paidPct, [rows[2]])];
out.otherOpenOrders = ids(b.otherOpenOrders(rows, rows[1]));
out.finishedPayState = finished.map(b.finishedPayState);
out.searchFinished = Object.fromEntries(["", "lycee", "#1079", "so-f2", "x"].map((q) => [q, ids(b.searchFinished(finished, q))]));
out.byFinishedPayment = Object.fromEntries(["all", "unpaid", "partial", "paid", "overdue"].map((s) => [s, ids(b.byFinishedPayment(finished, s))]));
out.totalValue = b.totalValue(rows);
out.utcToday = b.utcToday();
out.weeklyCounts = [b.weeklyCounts(["2026-11-10", "2026-11-09", "2026-11-08", "2026-10-01", "2026-09-20", "2026-11-11"], "2026-11-10"), b.weeklyCounts(["2026-11-10"], "2026-11-15", 2)];
out.avgLeadDays = [call(b.avgLeadDays, finished, "2026-11-10"), call(b.avgLeadDays, finished, "2026-11-10", 20), call(b.avgLeadDays, [], "2026-11-10")];
out.sortRows = {};
for (const key of ["age", "value", "customer", "ready"]) for (const flipped of [false, true]) out.sortRows[`${key}${flipped ? "-flipped" : ""}`] = ids(b.sortRows(rows, key, flipped, "fr"));
out.withFinished = b.withFinished(rows.slice(0, 1), finished).map((e) => ({ age_days: e.age_days, total: e.total, customer: e.customer, ready_ratio: e.ready_ratio, kind: e.open ? "open" : "fin" }));
const resp = (o) => ({ rows: [], computed_at: null, stock_loaded_at: null, sync: { enabled: true, configured: true, running: false, pending: 0, last_error: null, last_error_at: null, last_success_at: null, ...o.sync }, ...o });
const resps = { none: undefined, fresh: resp({}), computed: resp({ computed_at: "x", stock_loaded_at: "y" }), noStock: resp({ computed_at: "x" }), running: resp({ computed_at: "x", stock_loaded_at: "y", sync: { running: true } }), pending: resp({ sync: { pending: 3 } }), disabled: resp({ sync: { enabled: false } }), unconfigured: resp({ sync: { configured: false } }) };
out.isBoardReady = Object.fromEntries(Object.entries(resps).map(([k, v]) => [k, b.isBoardReady(v)]));
out.pollMs = Object.fromEntries(Object.entries(resps).map(([k, v]) => [k, b.pollMs(v)]));
out.ageTone = [0, 20, 21, 45, 46].map(b.ageTone);
out.formatQty = [1, 1.5, 1.005, 2.999, 0.1 + 0.2, -1.234].map(b.formatQty);
out.parseDay = ["2026-09-12", "2026-1", ""].map((d) => b.parseDay(d).toISOString());
const panel = row("p", { lines: [
  line("pa", { quantity: 5, shipped: 1, remaining: 4, packed_waiting: 2 }), line("pb", { state: "backorder", quantity: 3, remaining: 3 }),
  line("pc", { state: "shipped", quantity: 2, shipped: 2, remaining: 0 }), line("pd", { state: "service", item_id: null, quantity: 1 }),
  line("pe", { state: "cancelled", quantity: 4, cancelled: 4, remaining: 0 }), line("pf", { state: "to_order", quantity: 1.25, remaining: 1.25 }),
] });
out.panelGroups = b.panelGroups(panel).map((g) => ({ id: g.id, units: g.units, lines: g.lines.map((l) => [l.line.id, l.qty, l.ofQty]) }));
out.daysPastDue = ["2026-11-10", "2026-11-11", "2026-11-01", "2026-12-25"].map(b.daysPastDue);
out.packableUnits = [b.packableUnits(rows[0]), b.packableUnits({ lines: [line("x", { packable: 0.333 }), line("y", { packable: 1.111 })] })];
const check = { kind: "pack", picklist: { id: "pl1", number: "PL-1" }, max: { a: 2, b: 1.5, c: 0 }, qty: { a: 3, b: 0.333, c: 4 } };
out.checkLines = b.checkLines(check);
const scanLines = [{ id: "a", name: "Alpha", codes: ["ABC", "111"] }, { id: "b", name: "Beta", codes: ["abc"] }, { id: "c", name: "Gamma", codes: ["ZZZ"] }];
out.scanCheck = ["abc", " ABC ", "111", "zzz", "", "nope"].map((code) => { const r = b.scanCheck({ ...check, qty: { a: 2, b: 0 } }, scanLines, code); return { code, hit: r.hit, name: r.name, qty: r.check.qty }; });
out.scanCheckFull = b.scanCheck({ ...check, qty: { a: 2, b: 1.5 } }, scanLines, "abc").hit;
out.boxablePicklists = rows.map((r) => b.boxablePicklists(r).map((p) => p.id));
out.canPick = rows.map(b.canPick);
out.waitingPackages = rows.map((r) => b.waitingPackages(r).map((p) => p.id));
out.nextStep = [...rows, row("6", { lines: [line("6a")], packages: [{ id: "pk6", shipment_id: "", number: "P6", status: "not_shipped", date: "" }] })].map(b.nextStep);
const edit = b.startEdit(panel);
out.startEdit = { version: edit.version, qty: edit.qty, gone: [...edit.gone], added: edit.added };
edit.qty.pa = 3; edit.qty.pb = 0; edit.gone.add("pf"); edit.qty.pf = 7;
edit.added.push({ item: { id: "new1", name: "New", sku: "N1", rate: 250, stock_on_hand: 3, product_type: "goods" }, quantity: 1.005 });
out.editChanges = b.editChanges(panel, edit).map((c) => ({ kind: c.kind, line: c.line?.id, item: c.item?.id, from: c.from, to: c.to }));
out.editPayload = b.editPayload(panel, edit);
out.editTotal = [b.editTotal(panel, edit), b.editTotal({ ...panel, estimable: false }, edit), b.editTotal(panel, b.startEdit(panel))];
const pe = { packageId: "pk1", number: "PKG-1", picklist: "PL-1", version: "v", was: { a: 2, b: 1, z: 0 }, max: { a: 3, b: 1, c: 2 }, qty: { a: 1, b: 1, c: 5 } };
out.parcelDiff = b.parcelDiff(pe);
out.parcelLines = b.parcelLines(pe);
out.parcelWas = b.parcelWas(pe);

const S = B.status;
out.statusExports = Object.keys(S).sort();
out.TONE = S.TONE; out.FIT_VIEWPORT = S.FIT_VIEWPORT; out.STATUSES = S.STATUSES; out.ROW_GRID = S.ROW_GRID;
out.STATUS_META = Object.fromEntries(Object.entries(S.STATUS_META).map(([k, v]) => [k, { ...v, icon: iconName(v.icon) }]));
out.PAY_META = Object.fromEntries(Object.entries(S.PAY_META).map(([k, v]) => [k, { ...v, icon: iconName(v.icon) }]));

const E = B.errors;
out.errorsExports = Object.keys(E).sort();
const errs = {
  e503: new B.ApiError("busy", 503), e400code: new B.ApiError("version", 400), e400other: new B.ApiError("whatever", 400), e404: new B.ApiError("Order not found.", 404),
  e409: new B.ApiError("busy", 409), e502: new B.ApiError("Books says no", 502), e422: new B.ApiError("bad", 422), plain: new Error("plain"), str: "str", nul: null,
};
for (const code of ["below_floor", "unknown_item", "service_line", "nothing_changed", "package_shipped", "package_changed", "picklist_open", "unknown_line", "bad_quantity", "too_many", "picklist_shared"]) errs[`e400_${code}`] = new B.ApiError(code, 400);
out.isRefused = Object.fromEntries(Object.entries(errs).map(([k, v]) => [k, E.isRefused(v)]));
out.errorReason = Object.fromEntries(Object.entries(errs).map(([k, v]) => [k, E.errorReason(t, v)]));

const K = B.kinds;
out.kindsExports = Object.keys(K).sort();
out.SHORT_LABEL_KEY = K.SHORT_LABEL_KEY;
const KINDS = [...Object.keys(K.SHORT_LABEL_KEY), "unknown.kind"];
const DETAILS = [
  null, {}, { source: "shopify", reference: "#1079", units: 3, total: 12000, pickup: true }, { source: "quote", reference: "" }, { deleted: true, package: "PKG-1" },
  { package: "PKG-2", units: 2, picklist: "PL-3" }, { picklist: "PL-4", units: 1.5 }, { invoice: "INV-9", total: 5000, credit_applied: 1200, to: "a@b.test" },
  { amount: 2500, paid: 1000, total: 3000, document: "INV-9" }, { total_from: 100, total_to: 250 }, { to: "+68987123456" }, { amount: "x", units: "2" },
];
out.orderEventLabel = {}; out.orderEventDetail = {};
for (const kind of KINDS) {
  out.orderEventLabel[kind] = DETAILS.map((detail) => call(K.orderEventLabel, { kind, detail }, "XPF"));
  out.orderEventDetail[kind] = DETAILS.map((detail) => call(K.orderEventDetail, { kind, detail }, "XPF", t));
}
out.orderEventLabelEUR = call(K.orderEventLabel, { kind: "payment.received", detail: { amount: 1234.5 } }, "EUR");

const T = B.tracking;
out.trackingExports = Object.keys(T).sort();
out.orderStageIndex = ["received", "preparing", "ready", "handed_over", "bogus"].map(T.orderStageIndex);
out.orderStages = T.orderStages(t);
out.ORDER_LINE_TONE = T.ORDER_LINE_TONE;
const track = (state, counts, pickup = true) => ({ reference: "#1079", date: "2026-11-01", state, stage: "ready", lines: [], counts, pickup, payment: null, pay_url: null, updated_at: "" });
const STATES = [];
for (const state of ["received", "preparing", "partly_ready", "ready", "handed_over"]) for (const counts of [{ open: 3, ready: 0, waiting: 0 }, { open: 3, ready: 1, waiting: 1 }, { open: 3, ready: 2, waiting: 3 }, { open: 2, ready: 0, waiting: 2 }]) for (const pickup of [true, false]) STATES.push([state, counts, pickup]);
out.orderStatusCopy = STATES.map(([s, c, p]) => [s, c, p, T.orderStatusCopy(track(s, c, p), t)]);
const tl = [
  { status: "handed_over", handed_on: "2026-11-05" }, { status: "handed_over", handed_on: "2026-11-05T23:30:00" }, { status: "handed_over", handed_on: null },
  { status: "ready", handed_on: null }, { status: "preparing", handed_on: null }, { status: "to_prepare", handed_on: null }, { status: "waiting", handed_on: null },
];
out.orderLineLabel = Object.fromEntries(["fr", "en", "de"].map((lng) => [lng, tl.map((l) => T.orderLineLabel(l, t, lng))]));
out.orderTally = T.orderTally([...tl, { status: "ready" }, { status: "waiting" }]);

console.log(JSON.stringify(out, null, 1));
