/** Board-wide "reading mode" for the card hover reveal.
 *
 *  A card opens after a full second of the pointer resting on it. Once one
 *  card has been read, the pointer moving to the next one is not a new
 *  arrival, it is the same reader continuing down the column — so for a
 *  short window after a reveal closes, the next card opens after a much
 *  shorter dwell. The same rule tooltips follow: the first one waits, the
 *  rest keep up.
 *
 *  Module state rather than context: every card on the board shares one
 *  reader, and there is exactly one pointer. */

/** The pointer must rest this long on a card before it opens. */
export const HOVER_REVEAL_MS = 1000;
/** The dwell while the board is warm. */
export const WARM_REVEAL_MS = 300;
/** How long after leaving an open reveal the board stays warm. */
export const WARM_WINDOW_MS = 700;

let warmUntil = 0;

/** Called when an open reveal closes because the pointer left the card. */
export function markHoverWarm(now: number = Date.now()): void {
  warmUntil = now + WARM_WINDOW_MS;
}

/** The dwell a card should wait right now. */
export function hoverRevealDelay(now: number = Date.now()): number {
  return now < warmUntil ? WARM_REVEAL_MS : HOVER_REVEAL_MS;
}

/** Test-only: the window must not leak from one test into the next. */
export function __resetHoverWarmth(): void {
  warmUntil = 0;
}
