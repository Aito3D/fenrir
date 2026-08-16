// Snapshot probe: camera-grid pure layout/highlight logic over the full state
// matrix. Bundle produced by rolldown into /tmp/bambuddy-refactor-probe/ by the
// probe command in PROBES.json before this script runs.
const m = require("/tmp/bambuddy-refactor-probe/cameraGridLayout.cjs");

const states = ["RUNNING", "PAUSE", "FINISH", "FAILED", "IDLE", null];
const bools = [false, true];
const matrix = [];
for (const connected of bools)
  for (const state of states)
    for (const plateCleared of bools)
      for (const hasQueuedJobs of bools) {
        matrix.push({
          in: { connected, state, plateCleared, hasQueuedJobs },
          out: m.gridCardHighlightClass({ connected, state, plateCleared, hasQueuedJobs }),
        });
      }

const FIXED_NOW = 1700000001234; // deterministic epoch for blink phase math
console.log(
  JSON.stringify({
    highlightMatrix: matrix,
    blinkSync: {
      blinking: m.gridBlinkSyncStyle("animate-grid-border-blink", FIXED_NOW),
      steady: m.gridBlinkSyncStyle("!border-transparent", FIXED_NOW) ?? null,
    },
    layoutCols: m.GRID_LAYOUT_COLS,
    blinkPeriodMs: m.GRID_BLINK_PERIOD_MS,
  }),
);
