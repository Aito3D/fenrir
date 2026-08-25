/** The Quote and Invoice cards' action row, as one segmented control.
 *
 *  WHY A SEGMENTED CONTROL. Both cards live in the detail panel's first grid
 *  column — `minmax(0,20rem)` with `px-5`, inside a card with `p-3`, which
 *  leaves a usable row of exactly **230.4px** (measured, not computed: this
 *  app's root rem is 14.4px, so Tailwind's rem utilities are 10% smaller than
 *  they read). Three labelled pills wanted 253.6px, so "Print quote" and
 *  "Send quote" wrapped mid-phrase onto two lines. Shortening the labels fixed
 *  the wrap but left Russian clearing the row by 1.3px — one font fallback from
 *  breaking again. Dropping the labels entirely removes the constraint for
 *  every locale, and the shared border makes the three actions read as one
 *  deliberate object rather than three loose pills.
 *
 *  Names are carried by `aria-label` + `title` on each cell, so nothing is lost
 *  for screen readers or on hover — only the always-visible text is gone.
 *
 *  DIVIDERS ARE GAPS, NOT BORDERS. `gap-px` over the group's border-coloured
 *  background draws the hairlines. That is deliberate: `divide-x` and
 *  `last:border-r-0` both key off DOM sibling position, and SendQuoteButton
 *  renders its modal as a sibling of its own button (`fixed inset-0`, so it is
 *  out of flex flow but still a DOM child). Those selectors would then paint a
 *  border on the overlay, or leave the real last cell with a trailing edge.
 *  Gaps only apply to actual flex items, so an out-of-flow sibling cannot
 *  affect them.
 */

/** Container for exactly the three action cells. Includes the row's own top
 *  margin so both cards stay in step. */
export const ACTION_GROUP =
  'flex w-full mt-3 gap-px overflow-hidden rounded-md border border-bambu-dark-tertiary bg-bambu-dark-tertiary';

/** One cell. Owns its background so the `gap-px` hairlines read against it, and
 *  keeps the focus ring inset so the group's `overflow-hidden` cannot clip it. */
export const ACTION_CELL =
  'flex-1 inline-flex items-center justify-center py-[.45rem] bg-bambu-dark-secondary ' +
  'text-bambu-gray-light hover:text-white hover:bg-bambu-dark-tertiary ' +
  'transition-colors motion-reduce:transition-none ' +
  'disabled:opacity-40 disabled:cursor-not-allowed ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bambu-green/40';
