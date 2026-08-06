/** The panel's small-caps label style.
 *
 *  .72rem at .08em, not Tailwind's nearest pair (.75rem / .025em): on a few
 *  uppercase words set at 10px, the difference between .025em and .08em is the
 *  difference between a label and a caption.
 *
 *  It lives here rather than in ProjectDetailPanel because a stat rendered
 *  from its own file needs it too, and importing it from the parent that
 *  renders that stat would be a cycle. */
export const eyebrowCls = 'text-[.72rem] uppercase tracking-[.08em]';

/** The panel header row's status pills — quote status, destination, urgent.
 *
 *  One recipe, three callers, because that row is read as a single strip of
 *  facts and the pills had drifted into three different objects: the quote
 *  status was an uppercase .72rem eyebrow with .4rem padding while the other
 *  two were 11px semibold sentence case with a glyph, so they matched on
 *  neither type, height nor fill.
 *
 *  Shape, type and padding only. Tone — text, border and background colour —
 *  stays with each caller, because the colours are semantic (green for the
 *  quote, sky for a destination, amber for urgency) and are the one thing
 *  that SHOULD differ between them.
 *
 *  `gap-1.5` is here rather than at the callers so a pill without a glyph
 *  (quote status) still lines up with the ones that have one. */
export const headerPillCls =
  'inline-flex items-center gap-1.5 border rounded-[.4rem] px-2 py-0.5 text-[11px] font-semibold';

/** The same recipe, split for `HoldButton` callers (the urgent pill), which
 *  supplies its own `inline-flex`, `gap-1.5` and radius and therefore cannot
 *  take `headerPillCls` whole. Keep these two in step with it. */
export const headerPillRadiusCls = 'rounded-[.4rem]';
export const headerPillTypeCls = 'border px-2 py-0.5 text-[11px] font-semibold';
