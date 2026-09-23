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
// `filter` too: the filled cyan buttons brighten on hover (`hover:brightness-110`),
// and a filter outside the list snaps while colour and scale ease.
export const PRESS = 'active:scale-[0.97] transition-[color,background-color,transform,filter] duration-150';

export const delayAt = (ms: number): CSSProperties => ({ animationDelay: `${ms}ms` });

// The terms-toggle button's static classes — everything but the
// `terms.open` tail, which stays at each call site. Same base shape as the
// tracking pages' other pill buttons (see TrackingPayment's local `button`)
// with the outlined cyan treatment layered on; TrackingPayment and
// TrackingInvoice both render this exact button, so it is typed once here
// rather than twice in a different token order.
const TERMS_BUTTON_BASE =
  `inline-flex min-h-[44px] w-full shrink-0 items-center justify-center whitespace-nowrap rounded-[8px] px-[16px] text-[13.5px] font-semibold transition-[color,background-color,border-color,transform] duration-150 active:scale-[0.97] ${FOCUS} min-[400px]:w-auto`;
export const TERMS_BUTTON = `${TERMS_BUTTON_BASE} border text-aito-cyan hover:bg-aito-cyan/10 active:bg-aito-cyan/15`;

// The outer wrapper shared by every state of both tracking pages (each
// page's loading/404 branch and its main return): the same literal, not
// re-typed at each call site.
export const PAGE = 'min-h-screen bg-aito-midnight pt-[64px] pb-[48px] text-aito-ink';

// The locale chunk fetch behind each page's `ready` gate has the same
// failure mode as a hung tracking request or a hung code check — a
// stalled connection that never errors — so both pages give it the same
// deadline: past this, i18next's bundled English strings stand in rather
// than leave a client staring at a skeleton for data that has already
// arrived.
export const I18N_SETTLE_TIMEOUT_MS = 10_000;
