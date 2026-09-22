// Entry bundled by rolldown for the statistics-view frontend probe.
//
// Only the PURE modules of the feature: the timeframe maths the view drives
// its window with, the screen registry that names the tabs and their panels,
// and the palette every chart and legend reads its colours from. Components
// are deliberately absent — they need React, i18n and a query client to say
// anything, and the vitest suite already renders them.
export { computeDateRange, TIMEFRAME_PRESETS } from '../frontend/src/components/stats/timeframe';
export { STATS_SCREENS, statsTabId, statsScreenId } from '../frontend/src/components/aito/stats/screens';
export * as palette from '../frontend/src/components/aito/stats/palette';
