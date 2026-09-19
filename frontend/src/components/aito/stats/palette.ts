/** Chart colours for the statistics view, validated as categorical sets on
 *  the `#1a1a1a` surface (OKLCH band, chroma floor, colour-vision pairs,
 *  contrast) with the dataviz palette validator. Swap one and re-run the
 *  validator, not your eyes. Colours belong to the ENTITY: a filter that
 *  empties a series must not repaint the others. */

/** The three project moments, in the order they happen. */
export const SERIES = { created: '#3d86e8', accepted: '#c95aa0', done: '#219653' } as const;

/** The four services, in `SERVICES` order (scan, modeling, printing, machining). */
export const SERVICE_COLORS: Record<string, string> = {
  scan: '#3d86e8',
  modelisation: '#c95aa0',
  impression: '#c26a1c',
  usinage: '#1f9e8a',
};

/** Declined is a "no": the muted text tone, never a series hue, wherever it
 *  appears (decisions chart, win-rate bars). */
export const DECLINED = '#808080';
export const GRID = '#2d2d2d';
export const AXIS = '#808080';
export const TOOLTIP_ORDER = ['created', 'accepted', 'done', 'done7'];
