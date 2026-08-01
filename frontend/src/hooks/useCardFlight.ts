import { useEffect, useLayoutEffect, useRef } from 'react';
import { prefersReducedMotion } from '../utils/motion';

/** Where a card that has left the board went. `null` — deleted, filtered out
 *  by the search box, dropped by the server — animates nothing. */
export type FlightDeparture = 'archive' | null;

export interface CardFlightOptions {
  /** Suspends animation. Positions are still recorded while suspended, so
   *  resuming never replays a delta that accumulated behind a modal or under
   *  a drag — the same contract `useColumnReflow`'s nullable key has. */
  suspended: boolean;
  /** Answers for a card that is no longer on the board. Three different
   *  reasons look identical in the DOM — archived, trashed, filtered — and
   *  only the first has somewhere to fly to. */
  departureTarget: (key: string) => FlightDeparture;
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
/** The archive's landing pad — the "Show done" toggle carries it. */
const ARCHIVE_SELECTOR = '[data-flight-target]';
const ARCHIVE_END_SCALE = 0.28;
const PULSE_MS = 180;
/** Breathing room between a landed card and the edge it was panned past. */
const PAN_MARGIN_PX = 16;

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

/** How far the board must scroll for `rect` to sit inside its viewport,
 *  clamped to the scroller's real range. Positive scrolls right. Arithmetic
 *  only — nothing scrolls here, so the landing rect can be expressed in
 *  post-pan coordinates before a single pixel moves. */
function panFor(board: HTMLElement, rect: Rect): number {
  const view = board.getBoundingClientRect();
  let delta = 0;
  if (rect.left < view.left) delta = rect.left - view.left - PAN_MARGIN_PX;
  else if (rect.left + rect.width > view.right) delta = rect.left + rect.width - view.right + PAN_MARGIN_PX;
  if (delta === 0) return 0;
  const room = board.scrollWidth - board.clientWidth;
  return Math.max(-board.scrollLeft, Math.min(room - board.scrollLeft, delta));
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
  // A ghost is a picture of a card, not a card: it carries the same
  // hold-to-confirm buttons, drag grip and text as the real `CardView` it
  // was cloned from. `pointer-events: none` keeps a pointer off them but
  // does nothing for the tab order or the accessibility tree, so without
  // this a sighted keyboard user could tab into a control that vanishes
  // mid-flight and a screen reader would announce the card twice. `inert`
  // covers both; `aria-hidden` rides along because `inert` is younger than
  // the pointer-events rule and the two are cheap together.
  layer.inert = true;
  layer.setAttribute('aria-hidden', 'true');
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
  // A `view-transition-name` may be claimed by only one element at a time.
  // `useCardMorph.close` parks one on the real `[data-aito-card-id]` node
  // while its own transition finishes, and `expandedId` is already `null`
  // for that whole window — so a relocation landing in it clones a node that
  // still carries the name. Two elements claiming one name aborts the
  // running transition, so strip it from the root and every descendant,
  // the same sweep as the id above.
  ghost.style.viewTransitionName = '';
  for (const node of ghost.querySelectorAll<HTMLElement>('*')) node.style.viewTransitionName = '';
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
  board: HTMLElement;
  source: HTMLElement;
  from: Rect;
  to: Rect;
  /** Restores the real card the ghost stands in for. */
  reveal: () => void;
  /** Shrink and fade into the target instead of landing at full size. */
  archive: boolean;
  /** How far the board must pan to reveal the landing column; 0 for targets
   *  — like the archive toggle — that never move with the board. */
  panBy: number;
  /** Coordinates concurrent pans so only the newest one drives `scrollLeft`. */
  panOwner: { current: PanRun | null };
  /** Fires when the ghost lands. */
  onLand?: () => void;
}

function launch(spec: LaunchSpec): void {
  const { key, flights, layer, board, source, to, reveal, archive, panBy, panOwner, onLand } = spec;

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
    archive
      ? [
          { transform: 'scale(1)', opacity: 1 },
          // Legibly a card past the halfway mark, so what goes into the
          // archive is readable, not just that something did.
          { offset: 0.55, opacity: 1 },
          { transform: `scale(${ARCHIVE_END_SCALE})`, opacity: 0 },
        ]
      : [{ transform: 'scale(1)' }, { offset: 0.15, transform: `scale(${LIFT_SCALE})` }, { transform: 'scale(1)' }],
    { duration: ms, easing: archive ? 'ease-in' : 'ease-in-out', fill: 'forwards' },
  );

  // Set only if this flight actually starts a pan (`panBy !== 0`) below —
  // read by `stop()` so a retarget or a rollback that lands ON screen
  // (panBy === 0) still cancels the pan the flight it replaces was driving,
  // rather than leaving that pan to reach its own terminal frame and snap
  // the board to a target this flight never asked for.
  let panRun: PanRun | null = null;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    flights.delete(key);
    travel.cancel();
    ghost.remove();
    reveal();
    if (panRun && panOwner.current === panRun) panRun.cancel();
  };
  flights.set(key, { ghost, stop });
  // Resolves on landing, rejects on cancel; `stop` is idempotent either way,
  // so no path can strand a real card at opacity 0.
  travel.finished.then(() => {
    onLand?.();
    stop();
  }, stop);

  if (panBy !== 0) panRun = pan(board, panBy, travel, ghost, panOwner);
}

/** One pan in flight; a new one cancels it. */
interface PanRun {
  cancel: () => void;
}

/** Ride the flight's own clock rather than starting a second one.
 *  `getComputedTiming().progress` reports progress with the effect's easing
 *  already applied, so the board and the card cannot drift apart or settle on
 *  different frames — which is what a separately-timed smooth scroll does, and
 *  it lands the card somewhere the slot no longer is.
 *
 *  The first step runs synchronously so the pan is never a frame behind the
 *  ghost it is following.
 *
 *  `owner` holds at most one running pan. Two cards relocating to off-screen
 *  columns in the same render pass would otherwise spawn two loops writing an
 *  ABSOLUTE `scrollLeft` every frame, fighting each other for as long as both
 *  run. A new pan cancels whatever is running first, and a cancelled loop
 *  writes nothing further — not even its final snap — so a callback that was
 *  already queued when it got cancelled is a no-op if it still fires.
 *
 *  Returns the `PanRun` it started so the caller can hand it to the flight
 *  that owns it — `stop()` needs the handle to cancel this specific run,
 *  not just whatever happens to be current when it runs. */
function pan(
  board: HTMLElement,
  panBy: number,
  travel: Animation,
  ghost: HTMLElement,
  owner: { current: PanRun | null },
): PanRun {
  owner.current?.cancel();
  const start = board.scrollLeft; // where the board IS, not where a previous pan began
  let cancelled = false;
  let frame = 0;
  const run: PanRun = {
    cancel: () => {
      cancelled = true;
      if (frame) cancelAnimationFrame(frame);
    },
  };
  owner.current = run;
  const step = () => {
    if (cancelled) return;
    const progress = travel.effect?.getComputedTiming().progress;
    if (!ghost.isConnected || typeof progress !== 'number' || travel.playState !== 'running') {
      if (owner.current === run) owner.current = null;
      board.scrollLeft = start + panBy;
      return;
    }
    board.scrollLeft = start + panBy * progress;
    frame = requestAnimationFrame(step);
  };
  step();
  return run;
}

/** The archive's acknowledgement that it caught something. Its count has
 *  already ticked by the time this fires. */
function pulse(pad: HTMLElement): void {
  if (typeof pad.animate !== 'function') return;
  pad.animate([{ transform: 'scale(1)' }, { offset: 0.5, transform: 'scale(1.06)' }, { transform: 'scale(1)' }], {
    duration: PULSE_MS,
    easing: 'ease-out',
  });
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
  { suspended, departureTarget }: CardFlightOptions,
): void {
  const snapshotsRef = useRef(new Map<string, Snapshot>());
  const flightsRef = useRef(new Map<string, Flight>());
  const layerRef = useRef<HTMLElement | null>(null);
  const panOwnerRef = useRef<PanRun | null>(null);

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
      panOwnerRef.current?.cancel();
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

        const panBy = panFor(board, snapshot.rect);
        const target = snapshot.el;
        target.style.opacity = '0';
        launch({
          key,
          flights,
          layer: ensureLayer(layerRef),
          board,
          source: prev.el,
          from: prev.rect,
          // Post-pan coordinates: scrolling right by D moves the content left
          // by D, so the slot the card is flying to will be D further left by
          // the time it gets there.
          to: { ...snapshot.rect, left: snapshot.rect.left - panBy },
          archive: false,
          panBy,
          panOwner: panOwnerRef,
          reveal: () => {
            target.style.opacity = '';
          },
        });
      }

      for (const [key, prev] of previous) {
        if (next.has(key)) continue;
        if (departureTarget(key) !== 'archive') continue;
        if (!onScreen(board, prev.rect)) continue;
        const pad = document.querySelector<HTMLElement>(ARCHIVE_SELECTOR);
        if (!pad) continue;
        const padRect = pad.getBoundingClientRect();
        launch({
          key,
          flights,
          layer: ensureLayer(layerRef),
          board,
          source: prev.el,
          from: prev.rect,
          // Centred on the pad, so the shrink converges on the button rather
          // than on its top-left corner.
          to: {
            left: padRect.left + padRect.width / 2 - prev.rect.width / 2,
            top: padRect.top + padRect.height / 2 - prev.rect.height / 2,
            width: prev.rect.width,
            height: prev.rect.height,
          },
          archive: true,
          // The archive toggle lives in the toolbar, which never scrolls with
          // the board.
          panBy: 0,
          panOwner: panOwnerRef,
          reveal: () => {},
          onLand: () => pulse(pad),
        });
      }
    }

    snapshotsRef.current = next;
  });

  // Nothing may outlive the board: a ghost left behind would sit over the next
  // page, a card left at opacity 0 would be invisible, and a pan loop left
  // running would scroll a board this hook no longer owns.
  useEffect(
    () => () => {
      for (const flight of [...flightsRef.current.values()]) flight.stop();
      layerRef.current?.remove();
      layerRef.current = null;
      panOwnerRef.current?.cancel();
    },
    [],
  );
}
