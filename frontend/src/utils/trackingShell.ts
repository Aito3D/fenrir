import type { CSSProperties } from 'react';

/** Style tokens the public tracking pages share (the card, the focus ring,
 *  press feedback) — see components/aito/trackingShell.tsx for the pieces
 *  that render. */

export const BRAND = 'Aito3D';

// The card: fluid below 620 px (`calc(100% - 32px)` on phones), capped at
// 620 px and centred from `sm:` up — the finishing pass's own numbers
// (§7b "Composition and spacing" + "Final pixel pass"), not a redesign.
// `relative` anchors the language pill in its top-right corner.
export const CARD =
  'relative mx-auto w-[calc(100%-32px)] max-w-[620px] rounded-[12px] border border-aito-line bg-aito-card px-[24px] py-[24px] sm:w-auto sm:px-[32px] sm:py-[32px]';
export const FOCUS = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aito-cyan';
// Press feedback for the page's few buttons: a 3 % squeeze, under the
// vestibular threshold so it stays on under reduced motion. Tailwind v4's
// `hover:` is already gated on (hover: hover), so a tap never sticks.
export const PRESS = 'active:scale-[0.97] transition-[color,background-color,transform] duration-150';

export const delayAt = (ms: number): CSSProperties => ({ animationDelay: `${ms}ms` });
