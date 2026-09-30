// Campaign-22 golden probe: the camera wall's pure frontend logic and the
// card hover dwell, over fixed input matrices. Bundle produced by rolldown into
// /tmp/fenrir-refactor-probe/cameraFrontend.cjs by the probe command in
// PROBES.json before this script runs. Loop machinery, not app code.
globalThis.window = globalThis.window || { innerWidth: 1440, innerHeight: 900 };
const m = require("/tmp/fenrir-refactor-probe/cameraFrontend.cjs");

const out = {};

// --- cameraGridLayout: highlight class over the full state matrix ------------
const states = ["RUNNING", "PAUSE", "FINISH", "FAILED", "IDLE", null];
const bools = [false, true];
const highlightMatrix = [];
for (const connected of bools)
  for (const state of states)
    for (const plateCleared of bools)
      for (const hasQueuedJobs of bools) {
        highlightMatrix.push({
          in: { connected, state, plateCleared, hasQueuedJobs },
          out: m.layout.gridCardHighlightClass({ connected, state, plateCleared, hasQueuedJobs }),
        });
      }
const FIXED_NOW = 1700000001234;
out.layout = {
  highlightMatrix,
  blinkSync: {
    blinking: m.layout.gridBlinkSyncStyle("animate-grid-border-blink", FIXED_NOW),
    steady: m.layout.gridBlinkSyncStyle("!border-transparent", FIXED_NOW) ?? null,
  },
  layoutCols: m.layout.GRID_LAYOUT_COLS,
  spotlightSpan: m.layout.SPOTLIGHT_SPAN_CLASS,
  layoutIconKeys: Object.keys(m.layout.GRID_LAYOUT_ICONS),
  blinkPeriodMs: m.layout.GRID_BLINK_PERIOD_MS,
  maxPrinters: m.layout.GRID_STREAM_MAX_PRINTERS,
};

// --- cameraGridLayout: computeWallFit over counts × spotlights × viewports ----
const wallFit = [];
const counts = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 16, 20, 30];
const viewports = [
  [1920, 1080],
  [1280, 720],
  [1024, 1366],
  [800, 600],
  [3840, 2160],
];
for (const [width, height] of viewports)
  for (const count of counts)
    for (const spotlights of [0, 1, 2]) {
      wallFit.push({
        in: { count, spotlights, width, height, gap: 8 },
        out: m.layout.computeWallFit({ count, spotlights, width, height, gap: 8 }),
      });
    }
out.wallFitMatrix = wallFit;
out.wallFitEdges = {
  zeroCount: m.layout.computeWallFit({ count: 0, width: 1920, height: 1080, gap: 8 }),
  zeroWidth: m.layout.computeWallFit({ count: 4, width: 0, height: 1080, gap: 8 }),
  zeroHeight: m.layout.computeWallFit({ count: 4, width: 1920, height: 0, gap: 8 }),
  hugeGap: m.layout.computeWallFit({ count: 4, width: 100, height: 100, gap: 1000 }),
  spotlightsExceedCount: m.layout.computeWallFit({ count: 2, spotlights: 5, width: 1920, height: 1080, gap: 8 }),
  noGap: m.layout.computeWallFit({ count: 6, width: 1920, height: 1080, gap: 0 }),
  fractional: m.layout.computeWallFit({ count: 3, width: 1001.7, height: 599.3, gap: 7.5 }),
};

// --- hoverWarmth: the reading-mode dwell sequence ----------------------------
m.warmth.__resetHoverWarmth();
const warm = {
  constants: {
    HOVER_REVEAL_MS: m.warmth.HOVER_REVEAL_MS,
    WARM_REVEAL_MS: m.warmth.WARM_REVEAL_MS,
    WARM_WINDOW_MS: m.warmth.WARM_WINDOW_MS,
  },
  sequence: [],
};
const step = (label, fn) => warm.sequence.push({ label, delay: fn() });
step("cold at t=1000", () => m.warmth.hoverRevealDelay(1000));
m.warmth.markHoverWarm(1000);
step("warm at t=1000 (just marked)", () => m.warmth.hoverRevealDelay(1000));
step("warm at t=1699", () => m.warmth.hoverRevealDelay(1699));
step("cold again at t=1700 (window end, exclusive)", () => m.warmth.hoverRevealDelay(1700));
step("cold at t=5000", () => m.warmth.hoverRevealDelay(5000));
m.warmth.markHoverWarm(5000);
m.warmth.markHoverWarm(4000); // an older mark must shorten, not extend, the window
step("after re-mark at older time: t=4600", () => m.warmth.hoverRevealDelay(4600));
step("after re-mark at older time: t=4700", () => m.warmth.hoverRevealDelay(4700));
m.warmth.__resetHoverWarmth();
step("after reset at t=0", () => m.warmth.hoverRevealDelay(0));
step("negative time after reset", () => m.warmth.hoverRevealDelay(-1));
out.hoverWarmth = warm;

// --- GrowingBuffer -----------------------------------------------------------
const bufLog = [];
const B = m.buffer.GrowingBuffer;
const b = new B(8, 64);
const snap = (label) =>
  bufLog.push({ label, length: b.length, backing: b.buffer.byteLength, data: Array.from(b.data), byteOffset: b.byteOffset });
snap("fresh(8,64)");
b.append(new Uint8Array([1, 2, 3, 4, 5]));
snap("append 5");
b.append(new Uint8Array([6, 7, 8, 9, 10]));
snap("append 5 more (doubles)");
b.compact(4);
snap("compact(4)");
b.compact(0);
snap("compact(0) no-op");
b.compact(-3);
snap("compact(-3) no-op");
b.append(new Uint8Array(30));
snap("append 30 zeros (doubles twice)");
b.compact(34);
snap("compact to 2 bytes");
b.shrinkIfSparse();
snap("shrinkIfSparse (sparse)");
b.shrinkIfSparse();
snap("shrinkIfSparse again (already minimal)");
let overflow = null;
try {
  b.append(new Uint8Array(70));
} catch (e) {
  overflow = `${e.constructor.name}: ${e.message}`;
}
snap("after overflow attempt");
b.reset();
snap("reset");
const d = new B();
bufLog.push({ label: "defaults", length: d.length, backing: d.buffer.byteLength });
out.growingBuffer = { log: bufLog, overflow };

// --- constants + defaults ----------------------------------------------------
out.streamConstants = { ...m.constants };
globalThis.window.innerWidth = 1000;
out.cameraDefaults = { at1000: m.defaults.getDefaultState() };
globalThis.window.innerWidth = 300;
out.cameraDefaults.at300 = m.defaults.getDefaultState();

console.log(JSON.stringify(out, null, 1));
