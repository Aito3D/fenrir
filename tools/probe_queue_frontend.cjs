// Golden probe (Q1): the print queue UI's pure modules on fixed inputs — dispatch order and
// timeline lanes (utils/queueOrder), the job label (queueItemName), the thumbnail URL
// (queueItemThumbnail), the bulk-edit toast (queueBulkUpdate) and the mobile filter helpers
// (components/queue/mobile/queueFilters). Each module's export list is printed too, so an
// export added to or dropped from one of them moves this file.
const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() }; };
for (const name of ["localStorage", "sessionStorage"]) Object.defineProperty(globalThis, name, { value: store(), configurable: true, writable: true });
// The API client stamps thumbnail URLs with a load-time cache key: pin the clock.
const FIXED = Date.parse("2026-11-10T22:00:00Z");
const RealDate = Date;
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [FIXED])); } static now() { return FIXED; } };
const B = require("/tmp/fenrir-queue-probe/queueFrontend.cjs");

const call = (fn, ...args) => {
  try { const v = fn(...args); return v === undefined ? "__undefined__" : v; }
  catch (e) { return { __threw__: `${e.name}: ${e.message}` }; }
};
const out = { exports: Object.fromEntries(Object.entries(B).map(([k, v]) => [k, Object.keys(v).sort()])) };

// --- queueOrder
const O = B.order;
const items = [
  { id: 1, position: 3, printer_id: 1, print_time_seconds: 600 },
  { id: 2, position: 1, printer_id: null, target_model: "X1C", print_time_seconds: 7200 },
  { id: 3, position: 2, printer_id: 2, print_time_seconds: null },
  { id: 4, position: 2, printer_id: null, target_model: "X2D", print_time_seconds: 60, been_jumped: true },
  { id: 5, position: 5, printer_id: null, target_model: null },
  { id: 6, position: 4, printer_id: 0, target_model: "P1S", print_time_seconds: 0 },
  { position: 4, printer_id: 1, target_model: "P1P", print_time_seconds: 600, been_jumped: false },
  { id: 8, position: 1, printer_id: null, target_model: "", print_time_seconds: 600, been_jumped: true },
  { id: 9, position: -1, printer_id: undefined, target_model: "x1c", print_time_seconds: undefined },
];
const tag = (i) => i.id ?? "noid";
out.queueLaneKey = items.map((i) => [tag(i), call(O.queueLaneKey, i)]);
out.sorted = {
  byPosition: [...items].sort((a, b) => O.compareQueueOrder(a, b, false)).map(tag),
  shortestFirst: [...items].sort((a, b) => O.compareQueueOrder(a, b, true)).map(tag),
  reversedInputByPosition: [...items].reverse().sort((a, b) => O.compareQueueOrder(a, b, false)).map(tag),
  reversedInputShortestFirst: [...items].reverse().sort((a, b) => O.compareQueueOrder(a, b, true)).map(tag),
};
out.compareMatrix = {};
for (const sjf of [false, true]) out.compareMatrix[sjf ? "sjf" : "position"] = items.map((a) => items.map((b) => "<=>"[Math.sign(call(O.compareQueueOrder, a, b, sjf)) + 1]).join(""));
out.compareRaw = [
  [{ position: 1, id: 5 }, { position: 1, id: 2 }, false], [{ position: 1 }, { position: 1 }, true], [{ position: 2, print_time_seconds: 10 }, { position: 1, print_time_seconds: 10 }, true],
  [{ position: 2, print_time_seconds: 10 }, { position: 1, print_time_seconds: 20 }, true], [{ position: 2, print_time_seconds: 10 }, { position: 1, print_time_seconds: 20 }, false],
  [{ position: 9, been_jumped: true }, { position: 1, print_time_seconds: 1 }, true], [{ position: 9, been_jumped: true }, { position: 1, print_time_seconds: 1 }, false],
  [{ position: 1, print_time_seconds: null }, { position: 2, print_time_seconds: 0 }, true], [{ position: 1, print_time_seconds: null }, { position: 2 }, true],
].map(([a, b, sjf]) => ({ a, b, sjf, result: call(O.compareQueueOrder, a, b, sjf) }));

// --- queueItemName
const N = B.itemName;
const more = (n) => `(+${n} more)`;
const named = [
  { archive_name: "Archive name", library_file_name: "Library name", archive_id: 1, library_file_id: 2, variants: [{ filename: "v.3mf" }] },
  { archive_name: "", library_file_name: "Library name", archive_id: 1, library_file_id: 2 },
  { archive_name: null, library_file_name: null, archive_id: 7, library_file_id: 9 },
  { archive_id: null, library_file_id: 9 },
  { archive_id: 0, library_file_id: 9 },
  { archive_id: null, library_file_id: null },
  {},
  { variants: [] },
  { variants: [{ filename: "one.3mf" }] },
  { variants: [{ filename: "first.3mf" }, { filename: "second.3mf" }] },
  { variants: [{ filename: "first.3mf" }, { filename: "second.3mf" }, { filename: "third.3mf" }], archive_id: 4 },
  { archive_name: "Wins", variants: [{ filename: "first.3mf" }, { filename: "second.3mf" }] },
  { variants: [{ filename: "" }, { filename: "second.3mf" }] },
];
out.queueItemDisplayName = named.map((item) => ({ item, withMore: call(N.queueItemDisplayName, item, more), bare: call(N.queueItemDisplayName, item) }));

// --- queueItemThumbnail
const T = B.thumbnail;
const thumbs = [
  { archive_id: 3, archive_thumbnail: "t.png" }, { archive_id: 3, archive_thumbnail: "t.png", plate_id: 2 }, { archive_id: 3, archive_thumbnail: "t.png", plate_id: 0 },
  { archive_id: 3, archive_thumbnail: null, plate_id: 2 }, { archive_id: null, archive_thumbnail: "t.png" }, { archive_id: 0, archive_thumbnail: "t.png", plate_id: null },
  { library_file_id: 5, library_file_thumbnail: "l.png" }, { library_file_id: 5, library_file_thumbnail: "l.png", plate_id: 4 }, { library_file_id: 5, library_file_thumbnail: "" },
  { library_file_id: null, library_file_thumbnail: "l.png" }, { archive_id: 3, archive_thumbnail: "t.png", library_file_id: 5, library_file_thumbnail: "l.png", plate_id: 1 },
  { archive_id: 3, archive_thumbnail: "", library_file_id: 5, library_file_thumbnail: "l.png" }, { archive_id: 3, library_file_id: 5 }, {},
];
out.queueItemThumbnailUrl = thumbs.map((item) => ({ item, url: call(T.queueItemThumbnailUrl, item) }));

// --- queueBulkUpdate
out.bulkUpdateToast = [[0, 0], [0, 3], [2, 0], [2, 1], [1, -1], [-1, 0]].map(([updated_count, skipped_count]) => ({ updated_count, skipped_count, toast: call(B.bulk.bulkUpdateToast, { updated_count, skipped_count }) }));

// --- queueFilters
out.QUEUE_FILTER_STATUSES = B.filters.QUEUE_FILTER_STATUSES;
out.hasActiveQueueFilter = [[null, "", ""], [-1, "", ""], [0, "", ""], [3, "", ""], [null, "pending", ""], [null, "", "Lab"], [null, " ", ""], [2, "failed", "Lab"]].map((args) => ({ args, active: call(B.filters.hasActiveQueueFilter, ...args) }));

console.log(JSON.stringify(out, null, 1));
