import { useEffect, useLayoutEffect, useRef } from 'react';
import { prefersReducedMotion } from '../utils/motion';

export interface CardFlightOptions {
  /** Suspends animation. Positions are still recorded while suspended, so
   *  resuming never replays a delta that accumulated behind a modal or under
   *  a drag — the same contract `useColumnReflow`'s nullable key has. */
  suspended: boolean;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Snapshot {
  el: HTMLElement;
  parent: Element | null;
  rect: Rect;
}

interface Flight {
  ghost: HTMLElement;
  stop: () => void;
}

// keep in sync with --ease-flight in index.css
const EASE_FLIGHT = 'cubic-bezier(0.55, 0, 0.2, 1)';
const MIN_DURATION_MS = 280;
const MAX_DURATION_MS = 560;
const MS_PER_PX = 0.22;
const LIFT_SCALE = 1.02;

/** A flight is timed by how far it travels. A constant is wrong at both ends:
 *  280ms is leisurely for a one-column hop and a blur across the whole board. */
export function flightDuration(dx: number, dy: number): number {
  const distance = Math.hypot(dx, dy);
  return Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, MIN_DURATION_MS + distance * MS_PER_PX));
}

function liveTranslate(el: Element): { x: number; y: number } {
  const transform = getComputedStyle(el).transform;
  if (!transform || transform === 'none') return { x: 0, y: 0 };
  const matrix = new DOMMatrixReadOnly(transform);
  return { x: matrix.m41, y: matrix.m42 };
}

/** Where the element would be with nothing animating it.
 *
 *  `useColumnReflow` slides these very nodes with WAAPI transforms, and its
 *  layout effect runs BEFORE this one (React runs children first), so a raw
 *  rect taken here reports the animating position rather than the layout one.
 *  Only translate tweens ever touch these nodes — ours and dnd-kit's — so
 *  subtracting the live translate is enough; nothing scales them. */
function layoutRect(el: HTMLElement): Rect {
  const rect = el.getBoundingClientRect();
  const { x, y } = liveTranslate(el);
  return { left: rect.left - x, top: rect.top - y, width: rect.width, height: rect.height };
}

/** Any overlap at all with the board's viewport. A card scrolled out of its
 *  column had no departure the user could have seen, and flying it would make
 *  a card appear from behind a column edge. */
function onScreen(board: HTMLElement, rect: Rect): boolean {
  const view = board.getBoundingClientRect();
  return (
    rect.left < view.right &&
    rect.left + rect.width > view.left &&
    rect.top < view.bottom &&
    rect.top + rect.height > view.top
  );
}

/** One fixed, inert layer for every ghost. Created on the first flight because
 *  most sessions never have one. */
function ensureLayer(ref: { current: HTMLElement | null }): HTMLElement {
  const existing = ref.current;
  if (existing?.isConnected) return existing;
  const layer = document.createElement('div');
  layer.dataset.aitoFlightLayer = '';
  // z-40: above every column and card, below the z-50 detail panel, so a
  // flight can never paint over the modal.
  Object.assign(layer.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    right: '0',
    bottom: '0',
    pointerEvents: 'none',
    zIndex: '40',
  });
  document.body.appendChild(layer);
  ref.current = layer;
  return layer;
}

/** A pixel copy of the card, parked at the position it is flying FROM. */
function buildGhost(source: HTMLElement, from: Rect): { ghost: HTMLElement; face: HTMLElement } {
  const ghost = source.cloneNode(true) as HTMLElement;
  // The wrapper's classes are pure motion state — `animate-rise`, `opacity-30`
  // mid-drag, `animate-revert-flash` — and none of them belong on a ghost.
  ghost.className = '';
  ghost.removeAttribute('data-flip-key');
  // `useCardMorph` finds the card to morph the detail panel into by exactly
  // this selector. A ghost carrying it would be a second match.
  for (const node of ghost.querySelectorAll('[data-aito-card-id]')) node.removeAttribute('data-aito-card-id');
  Object.assign(ghost.style, {
    position: 'absolute',
    left: `${from.left}px`,
    top: `${from.top}px`,
    width: `${from.width}px`,
    height: `${from.height}px`,
    margin: '0',
    // dnd-kit may have left an inline transform on the node we cloned.
    transform: 'none',
    transition: 'none',
  });
  const face = ghost.querySelector<HTMLElement>('[data-aito-card]') ?? ghost;
  face.classList.add('shadow-2xl');
  return { ghost, face };
}

interface LaunchSpec {
  key: string;
  flights: Map<string, Flight>;
  layer: HTMLElement;
  source: HTMLElement;
  from: Rect;
  to: Rect;
  /** Restores the real card the ghost stands in for. */
  reveal: () => void;
}

function launch(spec: LaunchSpec): void {
  const { key, flights, layer, source, to, reveal } = spec;

  // Retarget: a card relocated twice in quick succession continues from where
  // its ghost visually IS, not from a layout position it no longer occupies.
  // The rect is read from the ghost BEFORE stopping it — `cancel()` removes
  // the effect immediately and would report the untransformed box.
  let from = spec.from;
  const running = flights.get(key);
  if (running) {
    const live = running.ghost.getBoundingClientRect();
    from = { left: live.left, top: live.top, width: from.width, height: from.height };
    running.stop();
  }

  const { ghost, face } = buildGhost(source, from);
  layer.appendChild(ghost);

  const dx = to.left - from.left;
  const dy = to.top - from.top;
  const ms = flightDuration(dx, dy);

  // A straight line. The board is a rail of columns; an arc would be
  // decoration pretending to be physics.
  const travel = ghost.animate(
    [{ transform: 'translate(0px, 0px)' }, { transform: `translate(${dx}px, ${dy}px)` }],
    { duration: ms, easing: EASE_FLIGHT, fill: 'forwards' },
  );

  // The lift rides the card's face, not the ghost wrapper: one element cannot
  // run two transform tweens, and folding the scale into the travel keyframes
  // would force the card's POSITION through the lift's midpoint too. No
  // rotation, deliberately — `CardView`'s drag overlay tilts because a hand is
  // holding it, and nothing is holding this one.
  face.animate(
    [{ transform: 'scale(1)' }, { offset: 0.15, transform: `scale(${LIFT_SCALE})` }, { transform: 'scale(1)' }],
    { duration: ms, easing: 'ease-in-out', fill: 'forwards' },
  );

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    flights.delete(key);
    travel.cancel();
    ghost.remove();
    reveal();
  };
  flights.set(key, { ghost, stop });
  // Resolves on landing, rejects on cancel; `stop` is idempotent either way,
  // so no path can strand a real card at opacity 0.
  travel.finished.then(stop, stop);
}

/** Fly a card from the column it left to the column it landed in.
 *
 *  Sibling to `useColumnReflow`, and the division between them is strict: that
 *  hook slides a column's own rows when the list around them changes, this one
 *  carries a card BETWEEN columns. Two systems animating one node fight
 *  visibly, so a move that is not a change of column is not this hook's.
 *
 *  The signal is the card's parent element changing between renders. All six
 *  columns are permanently mounted — the board filters their CONTENTS, never
 *  the columns — so that can mean nothing else, and it means no mutation, no
 *  column id and no prop has to be threaded here. A rollback, a relocation
 *  pushed by the Zoho reconciler, and another operator's move all animate for
 *  free, because the hook watches the DOM rather than who wrote the cache.
 *
 *  The ghost is a clone on a fixed layer rather than the real node, because
 *  every column is its own `overflow-y-auto` scroller inside a horizontally
 *  scrolling board: a translated card would be sliced at the column edge for
 *  the whole trip. */
export function useCardFlight(
  boardRef: React.RefObject<HTMLElement | null>,
  { suspended }: CardFlightOptions,
): void {
  const snapshotsRef = useRef(new Map<string, Snapshot>());
  const flightsRef = useRef(new Map<string, Flight>());
  const layerRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const board = boardRef.current;
    const flights = flightsRef.current;

    // The board is not on screen — the Done or Trash view has replaced it.
    // Forget everything: when the board returns, every column is a NEW
    // element, and a kept map would read as "every card changed column" and
    // fly the entire board at once.
    if (!board) {
      for (const flight of [...flights.values()]) flight.stop();
      snapshotsRef.current = new Map();
      return;
    }

    const previous = snapshotsRef.current;
    const next = new Map<string, Snapshot>();
    for (const node of board.querySelectorAll<HTMLElement>('[data-flip-key]')) {
      const key = node.getAttribute('data-flip-key');
      if (!key) continue;
      next.set(key, { el: node, parent: node.parentElement, rect: layoutRect(node) });
    }

    // Measure always, animate only when live.
    if (!suspended && !prefersReducedMotion() && typeof Element.prototype.animate === 'function') {
      for (const [key, snapshot] of next) {
        const prev = previous.get(key);
        // Never seen: an arrival to the BOARD (restored from the trash, or the
        // first paint). `useBoardDrag`'s `shouldAnimateIn` owns those.
        if (!prev) continue;
        if (prev.parent === snapshot.parent) continue;
        if (!onScreen(board, prev.rect)) continue;

        const target = snapshot.el;
        target.style.opacity = '0';
        launch({
          key,
          flights,
          layer: ensureLayer(layerRef),
          source: prev.el,
          from: prev.rect,
          to: snapshot.rect,
          reveal: () => {
            target.style.opacity = '';
          },
        });
      }
    }

    snapshotsRef.current = next;
  });

  // Nothing may outlive the board: a ghost left behind would sit over the next
  // page, and a card left at opacity 0 would be invisible.
  useEffect(
    () => () => {
      for (const flight of [...flightsRef.current.values()]) flight.stop();
      layerRef.current?.remove();
      layerRef.current = null;
    },
    [],
  );
}
