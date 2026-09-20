// Golden probe: the statistics view's pure frontend logic.
//
// Three things the screens read but no screen owns:
//
//   * `computeDateRange` — every figure on every screen is scoped by the
//     window this returns, so an off-by-one in a preset silently re-cuts the
//     whole view. Driven here against a frozen clock across every preset.
//   * `screens.ts` — the tab order and the DOM ids that bind each tab to its
//     panel. The ids are an accessibility contract (aria-controls); renaming
//     one breaks the hand-off with nothing to see on screen.
//   * `palette.ts` — the series colours, the declined grey, the grid and axis
//     tones, and the tooltip ordering. A chart that changes colour is a
//     behaviour change a test asserting on text would never catch.
//
// The bundle is produced by rolldown into /tmp/fenrir-refactor-probe/ by the
// probe command in PROBES.json before this script runs.
const m = require("/tmp/fenrir-refactor-probe/statsFrontend.cjs");

const { computeDateRange, TIMEFRAME_PRESETS, STATS_SCREENS, statsTabId, statsScreenId, palette } = m;

// A fixed clock. `computeDateRange` reads `new Date()`, so without this the
// probe would re-record itself every day. Chosen mid-month, mid-week
// (2026-03-11 is a Wednesday) so "this week" and "this month" both have a
// visible inside and outside.
const REAL_DATE = Date;
const FROZEN = new REAL_DATE("2026-03-11T14:30:00.000Z").getTime();
class FrozenDate extends REAL_DATE {
  constructor(...args) {
    if (args.length === 0) super(FROZEN);
    else super(...args);
  }
  static now() {
    return FROZEN;
  }
}
globalThis.Date = FrozenDate;

const out = {};

// Every preset the selector offers, plus the ones the type allows that the
// selector does not list — a preset that stops resolving is a blank view.
out.presets = TIMEFRAME_PRESETS;
out.ranges = {};
// 'custom' is in the type but not in the offered list, and returns an empty
// range the caller is expected to fill — probe it too, so a refactor that
// starts returning today's date there shows up.
for (const preset of [...TIMEFRAME_PRESETS, "custom"]) {
  const r = computeDateRange(preset);
  out.ranges[preset] = { dateFrom: r.dateFrom ?? null, dateTo: r.dateTo ?? null };
}

out.screens = {
  order: STATS_SCREENS,
  tabIds: Object.fromEntries(STATS_SCREENS.map((s) => [s, statsTabId(s)])),
  screenIds: Object.fromEntries(STATS_SCREENS.map((s) => [s, statsScreenId(s)])),
};

out.palette = {
  SERIES: palette.SERIES,
  SERVICE_COLORS: palette.SERVICE_COLORS,
  DECLINED: palette.DECLINED,
  GRID: palette.GRID,
  AXIS: palette.AXIS,
  TOOLTIP_ORDER: palette.TOOLTIP_ORDER,
};

globalThis.Date = REAL_DATE;
console.log(JSON.stringify(out, null, 2));
