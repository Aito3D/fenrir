// Golden probe: the Aito frontend's pure logic — optimistic cache updates,
// board layout/move rules, aging ramp, search and summary.
//
// These modules are ~1000 lines of pure functions over plain AitoProject
// objects, and they are exactly what a refactor churns. The probe pins their
// observable output over an edge-case matrix so a changed sort key, a dropped
// field or a shifted aging threshold shows up as a snapshot diff.
//
// The bundle is produced by rolldown into /tmp/bambuddy-refactor-probe/ by the
// probe command in PROBES.json before this script runs.
const m = require("/tmp/bambuddy-refactor-probe/aitoFrontend.cjs");

const { optimistic, board, aging, search, summary, rules } = m;

// A fixed clock: nothing below may read the real one. Any probe value that
// still varies run-to-run is a bug in the probe, not something to scrub.
const T0 = "2026-01-15T10:00:00Z";

function proj(over = {}) {
  return Object.assign(
    {
      id: 1,
      description: "A project",
      column: "devis",
      position: 1000,
      status: "active",
      client_id: null,
      client_name: null,
      client_phone: null,
      client_email: null,
      client_is_company: null,
      client_social_network: null,
      client_social_handle: null,
      quote_id: null,
      quote_number: null,
      quote_date: null,
      quote_total: null,
      quote_url: null,
      quote_salesperson: null,
      quote_status: null,
      quote_accepted_at: null,
      quote_sync_state: "idle",
      quote_invoiced: false,
      flag: null,
      quote_sync_error: null,
      quote_status_block: null,
      quote_status_remote: null,
      created_by: null,
      task_count: 0,
      tasks_total: 0,
      task_services: [],
      steps_total: 0,
      steps_done: 0,
      task_steps: [],
      task_pending: [],
      move_lock: null,
      shipping_island: null,
      shipping_service: null,
      shipping_first_name: null,
      shipping_last_name: null,
      shipping_phone: null,
      shipping_price: null,
      shipping_service_name: null,
      version: 1,
      created_at: T0,
      updated_at: T0,
    },
    over,
  );
}

const out = {};
const safe = (fn) => {
  try {
    const v = fn();
    return v === undefined ? "__undefined__" : v;
  } catch (e) {
    return { __threw__: `${e && e.name}: ${e && e.message}` };
  }
};

// --- a representative population -------------------------------------------
const POP = [
  proj({ id: 1, column: "devis", position: 1000, description: "Alpha scan" }),
  proj({ id: 2, column: "devis", position: 2000, flag: "urgent", description: "Beta urgent" }),
  proj({ id: 3, column: "devis", position: 500, flag: "sav", description: "Gamma sav" }),
  proj({ id: 4, column: "waiting", position: 1000, quote_status: "sent", description: "Delta waiting" }),
  proj({
    id: 5,
    column: "scan",
    position: 1000,
    quote_status: "accepted",
    quote_accepted_at: "2026-01-10T08:00:00Z",
    task_pending: ["scan"],
    steps_total: 3,
    steps_done: 1,
    description: "Epsilon scanning",
  }),
  proj({ id: 6, column: "print", position: 1000, task_pending: ["impression"], steps_total: 2, steps_done: 1 }),
  proj({ id: 7, column: "finish", position: 1000, steps_total: 2, steps_done: 2, description: "Zeta finishing" }),
  proj({ id: 8, column: "done", position: 1000, quote_invoiced: true, description: "Eta done invoiced" }),
  proj({ id: 9, column: "done", position: 2000, status: "trashed", description: "Theta trashed" }),
  proj({ id: 10, column: "devis", position: 1500, move_lock: "quote", description: "Iota locked" }),
];

// --- board layout ----------------------------------------------------------
out.COLUMN_IDS = board.COLUMN_IDS;
out.emptyBoard = board.emptyBoard();
out.flagRank = { null: board.flagRank(null), urgent: board.flagRank("urgent"), sav: board.flagRank("sav") };

const BUILT = board.buildBoard(POP);
const ids = (b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.map((p) => p.id)]));
out.buildBoard = ids(BUILT);
out.buildBoard_empty = ids(board.buildBoard([]));

out.findColumn = {};
for (const key of [1, 2, 5, 8, 9, 99, "1", "devis", "nope"]) {
  out.findColumn[JSON.stringify(key)] = safe(() => board.findColumn(BUILT, key));
}

out.applyCrossColumnMove = {};
for (const [activeId, overId] of [
  [1, "scan"],
  [1, "devis"],
  [5, "done"],
  [8, "devis"],
  [1, 4],
  [1, 1],
  [99, "scan"],
  [1, "nope"],
]) {
  out.applyCrossColumnMove[`${activeId}->${JSON.stringify(overId)}`] = safe(() =>
    ids(board.applyCrossColumnMove(BUILT, activeId, overId)),
  );
}

out.computeMoveTarget = {};
for (const [activeId, overId] of [
  [1, "scan"],
  [1, 2],
  [2, 1],
  [1, "devis"],
  [5, "finish"],
  [10, "scan"],
  [99, "scan"],
]) {
  out.computeMoveTarget[`${activeId}->${JSON.stringify(overId)}`] = safe(() =>
    board.computeMoveTarget(BUILT, activeId, overId),
  );
}

out.toOptimisticProjects = safe(() => board.toOptimisticProjects(BUILT).map((p) => [p.id, p.column, p.position]));

out.allowedColumns = {};
for (const p of POP) {
  out.allowedColumns[p.id] = safe(() => board.allowedColumns(p));
}
// allowedColumns over the move_lock and status matrix
for (const lock of [null, "quote", "waiting", "declined", "steps"]) {
  for (const st of [null, "sent", "accepted", "declined"]) {
    const key = `lock=${lock}/status=${st}`;
    out.allowedColumns[key] = safe(() => board.allowedColumns(proj({ move_lock: lock, quote_status: st })));
  }
}

// --- aging -----------------------------------------------------------------
const H = 3600_000;
const D = 24 * H;
out.agingLevel = {};
for (const ms of [
  -1, 0, 1, H, 6 * H, 12 * H, D - 1, D, D + 1, 2 * D, 3 * D, 5 * D, 7 * D, 10 * D, 14 * D, 21 * D, 30 * D, 60 * D,
  365 * D,
]) {
  out.agingLevel[ms] = safe(() => aging.agingLevel(ms));
}
out.agingColorCls = {};
out.agingTextCls = {};
for (let lvl = 0; lvl <= 6; lvl++) {
  out.agingColorCls[lvl] = safe(() => aging.agingColorCls(lvl));
  out.agingTextCls[lvl] = safe(() => aging.agingTextCls(lvl));
}
out.ageAnchor = {};
for (const [name, p] of Object.entries({
  "no-quote": proj({}),
  accepted: proj({ quote_status: "accepted", quote_accepted_at: "2026-01-10T08:00:00Z" }),
  "accepted-no-ts": proj({ quote_status: "accepted", quote_accepted_at: null }),
  "declined-after-accept": proj({ quote_status: "declined", quote_accepted_at: "2026-01-10T08:00:00Z" }),
  "sent-with-accept-ts": proj({ quote_status: "sent", quote_accepted_at: "2026-01-10T08:00:00Z" }),
})) {
  out.ageAnchor[name] = safe(() => aging.ageAnchor(p));
}

// --- search ----------------------------------------------------------------
out.matchesSearch = {};
for (const q of ["", " ", "alpha", "ALPHA", "alp", "zeta", "nomatch", "urgent", "scan", "1"]) {
  out.matchesSearch[JSON.stringify(q)] = POP.filter((p) => safe(() => search.matchesSearch(p, q)) === true).map(
    (p) => p.id,
  );
}
out.sortByRecencyDesc = {};
for (const q of ["", "alpha", "nomatch"]) {
  out.sortByRecencyDesc[JSON.stringify(q)] = safe(() => search.sortByRecencyDesc(POP, q).map((p) => p.id));
}
// stable ordering under equal timestamps is part of the contract
out.sortByRecencyDesc_sameTs = safe(() =>
  search
    .sortByRecencyDesc(
      [proj({ id: 30, updated_at: T0 }), proj({ id: 10, updated_at: T0 }), proj({ id: 20, updated_at: T0 })],
      "",
    )
    .map((p) => p.id),
);

// --- board rules (mirrored engine) -----------------------------------------
out.rules_SERVICES = rules.SERVICES;
out.rules_COLUMN_ORDER = rules.COLUMN_ORDER;

const TASKS = {
  empty: [],
  "one-untouched": [{ scan_cost: 10, scan_done: false }],
  "one-done": [{ scan_cost: 10, scan_done: true }],
  "zero-cost-step": [{ scan_cost: 0, scan_done: false }],
  "null-cost-absent": [{ scan_cost: null, scan_done: false }],
  multi: [
    { scan_cost: 10, scan_done: true, impression_cost: 20, impression_done: false },
    { modelisation_cost: 5, modelisation_done: false, usinage_cost: null, usinage_done: false },
  ],
  "all-done": [{ scan_cost: 1, scan_done: true, impression_cost: 2, impression_done: true }],
};
out.summariseTasks = {};
out.taskCost = {};
for (const [name, ts] of Object.entries(TASKS)) {
  out.summariseTasks[name] = safe(() => rules.summariseTasks(ts));
  out.taskCost[name] = safe(() => ts.map((t) => rules.taskCost(t)));
}

// --- summary ---------------------------------------------------------------
const DRAFTS = {
  empty: [],
  one: [{ title: "T1", scan_cost: "10", impression_cost: "", impression_quantity: "1" }],
  two: [
    { title: "A", scan_cost: "10" },
    { title: "B", impression_cost: "20", impression_quantity: "3" },
  ],
  "blank-title": [{ title: "", scan_cost: "5" }],
};
out.tasksSignature = {};
out.buildFallbackSummary = {};
const label = (id) => `[${id}]`;
for (const [name, ds] of Object.entries(DRAFTS)) {
  out.tasksSignature[name] = safe(() => summary.tasksSignature(ds));
  out.buildFallbackSummary[name] = safe(() => summary.buildFallbackSummary(ds, label));
}
// signature must be order-sensitive-or-not consistently; pin both orders
out.tasksSignature_reordered = safe(() => summary.tasksSignature([DRAFTS.two[1], DRAFTS.two[0]]));

// --- optimistic layer ------------------------------------------------------
out.isPlaceholder = {
  "normal-id": safe(() => optimistic.isPlaceholder(proj({ id: 5 }))),
  "negative-id": safe(() => optimistic.isPlaceholder(proj({ id: -1 }))),
  "zero-id": safe(() => optimistic.isPlaceholder(proj({ id: 0 }))),
};
// nextPlaceholderId is a counter: pin the DELTAS, not the absolute values, so
// the probe does not depend on how many times it was called before.
const pid1 = optimistic.nextPlaceholderId();
const pid2 = optimistic.nextPlaceholderId();
const pid3 = optimistic.nextPlaceholderId();
out.nextPlaceholderId_deltas = [pid2 - pid1, pid3 - pid2];
out.nextPlaceholderId_isPlaceholder = [
  optimistic.isPlaceholder(proj({ id: pid1 })),
  optimistic.isPlaceholder(proj({ id: pid3 })),
];

out.rankBySourceColumn = safe(() =>
  optimistic.rankBySourceColumn(POP, "devis").map((p) => [p.id, p.column, p.position]),
);
for (const col of board.COLUMN_IDS) {
  out[`rankBySourceColumn_${col}`] = safe(() =>
    optimistic.rankBySourceColumn(POP, col).map((p) => [p.id, p.position]),
  );
}

// Dumping the whole population for every case produced a 300KB golden, which
// nobody can review. Emit the DELTA against POP instead: length, order, and the
// per-project fields that actually changed. A dropped field or a reordered list
// still shows up; unchanged rows cost nothing.
const pick = (r) => {
  if (r === undefined) return "__undefined__";
  if (!Array.isArray(r)) return r;
  const before = new Map(POP.map((p) => [p.id, summarise1(p)]));
  const changed = {};
  for (const p of r) {
    const now = summarise1(p);
    const was = before.get(p.id);
    if (!was) {
      changed[p.id] = { __added__: now };
      continue;
    }
    const d = {};
    for (const k of Object.keys(now)) {
      if (JSON.stringify(now[k]) !== JSON.stringify(was[k])) d[k] = [was[k], now[k]];
    }
    if (Object.keys(d).length) changed[p.id] = d;
  }
  const seen = new Set(r.map((p) => p.id));
  const removed = POP.filter((p) => !seen.has(p.id)).map((p) => p.id);
  return { order: r.map((p) => p.id), len: r.length, changed, removed };
};

function summarise1(p) {
  return {
    id: p.id,
    column: p.column,
    position: p.position,
    status: p.status,
    quote_status: p.quote_status,
    quote_sync_state: p.quote_sync_state,
    quote_invoiced: p.quote_invoiced,
    description: p.description,
    steps_total: p.steps_total,
    steps_done: p.steps_done,
    task_pending: p.task_pending,
    task_count: p.task_count,
    tasks_total: p.tasks_total,
    move_lock: p.move_lock,
    version: p.version,
    flag: p.flag,
    shipping_island: p.shipping_island,
    shipping_price: p.shipping_price,
    shipping_service: p.shipping_service,
    shipping_service_name: p.shipping_service_name,
    client_social_network: p.client_social_network,
    client_social_handle: p.client_social_handle,
    updated_at: p.updated_at,
  };
}

out.applyQuoteStatus = {};
for (const st of [null, "sent", "accepted", "declined", "invoiced", "weird"]) {
  out.applyQuoteStatus[JSON.stringify(st)] = safe(() => pick(optimistic.applyQuoteStatus(POP, 5, st)));
}
out.applyQuoteStatus_undefinedList = safe(() => optimistic.applyQuoteStatus(undefined, 5, "sent"));
out.applyQuoteStatus_missingId = safe(() => pick(optimistic.applyQuoteStatus(POP, 999, "sent")));

out.applyTaskSummary = {};
for (const [name, ts] of Object.entries(TASKS)) {
  out.applyTaskSummary[name] = safe(() => pick(optimistic.applyTaskSummary(POP, 5, ts)));
}

out.applyDescription = {
  normal: safe(() => pick(optimistic.applyDescription(POP, 1, "new text"))),
  empty: safe(() => pick(optimistic.applyDescription(POP, 1, ""))),
  missing: safe(() => pick(optimistic.applyDescription(POP, 999, "x"))),
  undefinedList: safe(() => optimistic.applyDescription(undefined, 1, "x")),
};

out.applySyncState = {};
for (const st of ["unmanaged", "idle", "pending", "error", "locked"]) {
  out.applySyncState[st] = safe(() => pick(optimistic.applySyncState(POP, 5, st)));
}

out.applyShipping = {};
for (const [name, patch] of Object.entries({
  attach: {
    shipping_island: "tahiti",
    shipping_service: "aerien",
    shipping_first_name: "A",
    shipping_last_name: "B",
    shipping_phone: "87000000",
    shipping_price: 1500,
  },
  "attach-zero-price": {
    shipping_island: "raiatea",
    shipping_service: "aerien",
    shipping_first_name: "A",
    shipping_last_name: "B",
    shipping_phone: "8",
    shipping_price: 0,
  },
  detach: { shipping_island: null },
  "null-price": {
    shipping_island: "tahiti",
    shipping_service: "aerien",
    shipping_first_name: "A",
    shipping_last_name: "B",
    shipping_phone: "8",
    shipping_price: null,
  },
  empty: {},
})) {
  out.applyShipping[name] = safe(() => pick(optimistic.applyShipping(POP, 5, patch)));
}

out.applyClientSocial = {};
for (const [name, args] of Object.entries({
  both: ["instagram", "@me"],
  "both-null": [null, null],
  "network-only": ["whatsapp", null],
  "handle-only": [null, "@x"],
  "empty-strings": ["", ""],
})) {
  out.applyClientSocial[name] = safe(() => pick(optimistic.applyClientSocial(POP, 1, args[0], args[1])));
}

out.applyDelete = {
  existing: safe(() => pick(optimistic.applyDelete(POP, 5))),
  missing: safe(() => pick(optimistic.applyDelete(POP, 999))),
  undefinedList: safe(() => optimistic.applyDelete(undefined, 5)),
};

out.applyColumnMove = {};
for (const [id, col, pos] of [
  [1, "scan", 1000],
  [1, "devis", 1],
  [5, "done", 9999],
  [8, "devis", 0],
  [999, "scan", 100],
  [1, "nope", 100],
]) {
  out.applyColumnMove[`${id}->${col}@${pos}`] = safe(() => pick(optimistic.applyColumnMove(POP, id, col, pos)));
}
out.applyColumnMove_undefinedList = safe(() => optimistic.applyColumnMove(undefined, 1, "scan", 1));

out.applyRestore = {
  "restore-trashed": safe(() => pick(optimistic.applyRestore(POP, proj({ id: 9, status: "active" })))),
  "restore-new": safe(() => pick(optimistic.applyRestore(POP, proj({ id: 77, description: "New" })))),
  undefinedList: safe(() => optimistic.applyRestore(undefined, proj({ id: 9 }))),
};

// placeholderProject / applyCreate may stamp a clock; keep only the fields that
// cannot vary, and record WHICH fields look timestamp-shaped instead of their
// values, so a shape change is still caught.
const PH_FIELDS = {
  minimal: { description: "New card" },
  full: {
    description: "Full card",
    client_name: "Client",
    client_phone: "87",
    client_email: "a@b.c",
    client_is_company: true,
  },
};
out.placeholderProject = {};
for (const [name, fields] of Object.entries(PH_FIELDS)) {
  out.placeholderProject[name] = safe(() => {
    const p = optimistic.placeholderProject(fields);
    const shaped = {};
    for (const [k, v] of Object.entries(p)) {
      shaped[k] =
        typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)
          ? "__timestamp__"
          : k === "id" && typeof v === "number" && v < 0
            ? "__placeholder_id__"
            : v;
    }
    return shaped;
  });
}
out.applyCreate = safe(() => {
  const created = optimistic.applyCreate(POP, optimistic.placeholderProject({ description: "Created" }));
  return created === undefined
    ? "__undefined__"
    : created.map((p) => ({
        ...summarise1(p),
        id: p.id < 0 ? "__placeholder_id__" : p.id,
        created_at: "__ignored__",
        updated_at: "__ignored__",
      }));
});

// Insertion order is fixed by this script, so plain stringify is already
// deterministic. (An array second argument would be a key FILTER applied at
// every depth, which would silently drop nested keys — do not "fix" it to that.)
process.stdout.write(JSON.stringify(out, null, 1) + "\n");
