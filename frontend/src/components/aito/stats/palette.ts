/** Chart colours for the statistics view, validated as categorical sets on
 *  the `#1a1a1a` surface (OKLCH band, chroma floor, colour-vision pairs,
 *  contrast) with the dataviz palette validator. Swap one and re-run the
 *  validator, not your eyes. Colours belong to the ENTITY: a filter that
 *  empties a series must not repaint the others. */

/** The three project moments, in the order they happen. */
export const SERIES = { created: '#3d86e8', accepted: '#c95aa0', done: '#219653' } as const;

/** The five services, in `SERVICES` order (scan, modeling, printing,
 *  machining, labour). */
export const SERVICE_COLORS: Record<string, string> = {
  scan: '#3d86e8',
  modelisation: '#c95aa0',
  impression: '#c26a1c',
  usinage: '#1f9e8a',
  maindoeuvre: '#8f7ae5',
};

/** Quote decisions are a yes/no, not a project moment, so the Sales panels
 *  (decisions chart, win-rate bars) paint them as a status pair: a pastel green
 *  field for accepted and a deeper pastel red cap for declined. The red sits
 *  one lightness step below the green on purpose: two pastels at the same
 *  lightness merge for red-green colour blindness (deutan dE ~3), the split
 *  keeps them apart (dE 14.6). Validated on the dark surface only; the light
 *  theme would need a deeper step of the same hues. */
export const DECISION = { accepted: '#8fd4a8', declined: '#d4706f' } as const;
export const GRID = '#2d2d2d';
export const AXIS = '#808080';
export const TOOLTIP_ORDER = ['created', 'accepted', 'done', 'done7'];
