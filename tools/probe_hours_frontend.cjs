// Golden probe: the Hours page's pure frontend rules (frontend/src/utils/hoursSeries.ts)
// — series building, interpolation, monthly buckets, pace/forecast, sheet-paste
// parsing, import planning, reading sanity checks, family colours and fleet facts.
// Fixed inputs, deterministic output; TZ=UTC is set by PROBES.json.
const m = require("/tmp/fenrir-refactor-probe/hoursFrontend.cjs");
const h = m.hoursSeries;

const safe = (fn) => {
  try {
    const v = fn();
    return v === undefined ? "__undefined__" : v;
  } catch (e) {
    return { __threw__: `${e && e.name}: ${e && e.message}` };
  }
};
const mapToObj = (mp) => Object.fromEntries([...mp.entries()].map(([k, v]) => [String(k), v]));

const machines = [
  { id: 1, printer_id: 1, name: "X1C04", model: "X1C", retired: false, current_hours: 134, trust: "calibrated", last_drift_hours: null, calibrated_at: null, counter_raw_hours: 124, next_service_hours: null, purchase_price: 1200, purchase_date: "2024-01-10", added_on: "2024-01-10" },
  { id: 2, printer_id: 2, name: "X1C01", model: "X1C", retired: false, current_hours: 50, trust: "uncalibrated", last_drift_hours: null, calibrated_at: null, counter_raw_hours: 50, next_service_hours: null, purchase_price: null, purchase_date: null, added_on: null },
  { id: 3, printer_id: null, name: "P1S old", model: null, retired: true, current_hours: null, trust: null, last_drift_hours: null, calibrated_at: null, counter_raw_hours: null, next_service_hours: null, purchase_price: null, purchase_date: null, added_on: null },
  { id: 4, printer_id: 4, name: "h2d-02", model: null, retired: false, current_hours: 10, trust: "drifting", last_drift_hours: 30, calibrated_at: null, counter_raw_hours: 10, next_service_hours: 500, purchase_price: null, purchase_date: null, added_on: null },
  { id: 5, printer_id: 5, name: "Mystery", model: "Unknown", retired: false, current_hours: 0, trust: "uncalibrated", last_drift_hours: null, calibrated_at: null, counter_raw_hours: 0, next_service_hours: null, purchase_price: null, purchase_date: null, added_on: null },
  { id: 6, printer_id: 6, name: "X1C02", model: "X1C", retired: false, current_hours: 5, trust: "uncalibrated", last_drift_hours: null, calibrated_at: null, counter_raw_hours: 5, next_service_hours: null, purchase_price: null, purchase_date: null, added_on: null },
];

let rid = 0;
const R = (machine_id, reading_date, hours, source = "manual", raw_hours = null) => ({ id: ++rid, machine_id, reading_date, hours, source, raw_hours });
const readings = [
  R(1, "2026-01-15", 900),
  R(1, "2026-03-01", 1000),
  R(1, "2026-04-20", 1100),
  R(1, "2026-04-10", 1050, "auto", 90), // older than the last manual -> dropped from the series
  R(1, "2026-04-22", 1104, "auto", 124), // first auto after the last manual (raw counter 124)
  R(1, "2026-05-01", 1130, "auto", 150),
  R(1, "2026-05-10", 1090, "auto", 160), // lower than the last manual -> uncalibrated counter, dropped
  R(2, "2026-02-01", 10),
  R(2, "2026-02-02", 10),
  R(3, "2025-06-01", 400),
  R(3, "2025-12-01", 420),
  R(4, "2026-04-01", 100),
  R(4, "2026-04-30", 95), // counter reset -> clamps to 0 in buckets
  R(6, "2026-04-29", 5),
];
const today = "2026-05-12";

const out = {};
out.dayNumber = Object.fromEntries(["1970-01-01", "1970-01-02", "2000-02-29", "2026-05-12", "2026-12-31"].map((d) => [d, h.dayNumber(d)]));

const series = new Map(machines.map((mc) => [mc.id, h.machineSeries(readings, mc.id)]));
out.machineSeries = mapToObj(series);
out.seriesPoints = mapToObj(new Map([...series].map(([id, s]) => [id, h.seriesPoints(s)])));

const p1 = h.seriesPoints(series.get(1));
out.valueAt = Object.fromEntries(["2025-12-31", "2026-01-15", "2026-02-07", "2026-03-01", "2026-04-21", "2026-05-01", "2026-06-01"].map((d) => [d, h.valueAt(p1, d)]));
out.valueAtEmpty = h.valueAt([], today);
out.valueAtSingle = h.valueAt([{ date: "2026-01-01", hours: 7 }], "2026-03-03");

out.monthStarts = {
  same: h.monthStarts("2026-05-03", "2026-05-20"),
  span: h.monthStarts("2025-11-20", "2026-02-01"),
  inverted: h.monthStarts("2026-03-01", "2026-01-01"),
};
const months = h.monthStarts("2025-12-01", today);
out.monthlyHours = Object.fromEntries([1, 2, 3, 4, 6].map((id) => [id, h.monthlyHours(h.seriesPoints(series.get(id)), months)]));
out.fleetTotal = h.fleetTotal([1, 2, 3, 4].map((id) => h.seriesPoints(series.get(id))), ["2025-12-01", "2026-02-01", "2026-04-15", today]);

out.ratePerMonth = {
  m1: h.ratePerMonth(p1, today),
  m1_window30: h.ratePerMonth(p1, today, 30),
  m1_shortWindow: h.ratePerMonth(p1, "2026-04-23", 2),
  m2_twoDays: h.ratePerMonth(h.seriesPoints(series.get(2)), today),
  m3_stale: h.ratePerMonth(h.seriesPoints(series.get(3)), today),
  m4_reset: h.ratePerMonth(h.seriesPoints(series.get(4)), today),
  single: h.ratePerMonth([{ date: "2026-05-01", hours: 1 }], today),
};

const CELLS = ["", "  ", "0", "0,0", "12", "12.5", "12,5", "1,234", "1,234.5", "1 234", "1 234,5", "1,23,4", "-3", "abc", "3h", "1.2.3", "007", "1,000,000"];
out.parseHoursCell = Object.fromEntries(CELLS.map((c) => [JSON.stringify(c), h.parseHoursCell(c)]));
out.parseHoursInput = Object.fromEntries(CELLS.map((c) => [JSON.stringify(c), safe(() => h.parseHoursInput(c))]));
const DATES = ["2026-05-12", " 2026-05-12 ", "12/05/2026", "1/5/2026", "31/02/2026", "2026-02-30", "2026-13-01", "05/12/26", "2026/05/12", "", "today", "29/02/2024", "29/02/2023"];
out.parseDateCell = Object.fromEntries(DATES.map((c) => [JSON.stringify(c), h.parseDateCell(c)]));

const PASTE = "Date\tX1C04\tx1c01\tH2D-07\tTotal\t\t\n" +
  "15/01/2026\t900\t\t\t900\n" +
  "01/03/2026\t1000\t10\t\t1010\n" +
  "not a date\t1\t2\t3\n" +
  "\n" +
  "20/04/2026\t1 100\t12,5\t0\t1112.5\n" +
  "2026-06-01\t1200\t20\t40\t1260\r\n";
const paste = h.parseSheetPaste(PASTE);
out.parseSheetPaste = { paste, empty: h.parseSheetPaste(""), blankLines: h.parseSheetPaste("\n\n  \n"), headerOnly: h.parseSheetPaste("Date\tA\tB") };
out.planImport = {
  defaults: h.planImport(paste, machines, {}, today),
  choices: h.planImport(paste, machines, { "H2D-07": "ignore", Total: "create" }, today),
  dupHeaders: h.planImport(h.parseSheetPaste("Date\tA1\ta1\t\tA1\n01/01/2026\t1\t2\t3\t4"), [], {}, today),
};

out.guessModel = Object.fromEntries(["X1C04", " p1s-2", "H2D", "h2c lab", "A1 mini", "A1", "P2S", "Prusa", "", "X1E7", "x1c"].map((n) => [JSON.stringify(n), h.guessModel(n)]));
out.familyOf = machines.map((mc) => [mc.name, h.familyOf(mc)]);
out.familyOfEdge = [h.familyOf({ model: "X1 Carbon", name: "a" }), h.familyOf({ model: "", name: "p1s" }), h.familyOf({ model: null, name: "zzz" })];
out.railOrder = h.railOrder(machines).map((mc) => mc.id);
out.machineColors = mapToObj(h.machineColors(machines));

out.checkReading = {
  noManual: h.checkReading(5, 100, readings, 10),
  backwards: h.checkReading(1, 1000, readings, 160),
  okWithCounter: h.checkReading(1, 1136, readings, 160),
  far: h.checkReading(1, 1300, readings, 160),
  noCounterNow: h.checkReading(1, 1300, readings, null),
  noRawThen: h.checkReading(2, 20, readings, 60),
  exactEdge: h.checkReading(1, 1136 + 24, readings, 160),
};

const periods1 = h.periodPaces(series.get(1).manual);
out.periodPaces = { m1: periods1, m4: h.periodPaces(series.get(4).manual), sameDay: h.periodPaces([{ date: "2026-01-01", hours: 1 }, { date: "2026-01-01", hours: 5 }]), single: h.periodPaces([{ date: "2026-01-01", hours: 1 }]) };
out.behaviourFlag = {
  m1: h.behaviourFlag(periods1),
  none: h.behaviourFlag([]),
  stopped: h.behaviourFlag([{ from: "a", to: "b", days: 45, pace: 0.5 }]),
  slowing: h.behaviourFlag([{ from: "a", to: "b", days: 10, pace: 100 }, { from: "b", to: "c", days: 10, pace: 40 }]),
  steady: h.behaviourFlag([{ from: "a", to: "b", days: 10, pace: 100 }, { from: "b", to: "c", days: 10, pace: 60 }]),
  shortStop: h.behaviourFlag([{ from: "a", to: "b", days: 10, pace: 0 }]),
};
out.loadShare = [null, 0, 100, 730.56].map((p) => h.loadShare(p));
out.forecastDate = {
  ok: h.forecastDate({ date: "2026-04-20", hours: 1100 }, 60, 1500),
  past: h.forecastDate({ date: "2026-04-20", hours: 1100 }, 60, 1000),
  noPace: h.forecastDate({ date: "2026-04-20", hours: 1100 }, null, 1500),
  zeroPace: h.forecastDate({ date: "2026-04-20", hours: 1100 }, 0, 1500),
  yearWrap: h.forecastDate({ date: "2026-12-20", hours: 0 }, 30.44, 60),
};
out.sameAgePoints = { m1: h.sameAgePoints(p1), empty: h.sameAgePoints([]) };
out.fleetFacts = {
  all: h.fleetFacts(machines, series, readings, today, [2, 6]),
  noSeriesMap: h.fleetFacts(machines, new Map(), readings, today, []),
  monthStartDay: h.fleetFacts(machines, series, readings, "2026-05-01", []),
};
out.gapInfo = { all: h.gapInfo(machines, series, today), none: h.gapInfo([machines[2]], series, today), empty: h.gapInfo([], new Map(), today) };

console.log(JSON.stringify(out, null, 1));
