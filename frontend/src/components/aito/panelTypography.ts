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
