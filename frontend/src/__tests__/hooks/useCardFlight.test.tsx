import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCardFlight, flightDuration, type CardFlightOptions } from '../../hooks/useCardFlight';

interface Recorded {
  el: Element;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

let recorded: Recorded[] = [];
let options: CardFlightOptions;

/** jsdom implements no animations at all — `element.animate` is absent rather
 *  than inert — so record the calls instead. What the hook DECIDES (which
 *  element, which keyframes, how long) is the entire behaviour worth pinning;
 *  the pixels are the browser's job. */
function stubAnimate() {
  recorded = [];
  Element.prototype.animate = function (this: Element, keyframes, animationOptions) {
    recorded.push({
      el: this,
      keyframes: keyframes as Keyframe[],
      options: (animationOptions ?? {}) as KeyframeAnimationOptions,
    });
    return {
      finished: Promise.resolve(),
      cancel: () => {},
      playState: 'finished',
      effect: { getComputedTiming: () => ({ progress: 1 }) },
    } as unknown as Animation;
  } as typeof Element.prototype.animate;
}

function place(el: HTMLElement, box: Box) {
  el.getBoundingClientRect = () =>
    ({
      ...box,
      right: box.left + box.width,
      bottom: box.top + box.height,
      x: box.left,
      y: box.top,
      toJSON: () => ({}),
    }) as DOMRect;
}

function buildCard(id: string, box: Box) {
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-flip-key', id);
  // The wrapper's real classes are pure motion state — the ghost must not
  // inherit them (see the strip test below).
  wrapper.className = 'animate-rise';
  const face = document.createElement('div');
  face.setAttribute('data-aito-card', '');
  face.setAttribute('data-aito-card-id', id);
  wrapper.appendChild(face);
  place(wrapper, box);
  return wrapper;
}

function buildBoard() {
  const board = document.createElement('div');
  place(board, { left: 0, top: 0, width: 1200, height: 800 });
  const left = document.createElement('div');
  const right = document.createElement('div');
  board.append(left, right);
  document.body.appendChild(board);
  return { board, left, right };
}

function buildArchivePad() {
  const pad = document.createElement('button');
  pad.setAttribute('data-flight-target', '');
  place(pad, { left: 900, top: 0, width: 160, height: 40 });
  document.body.appendChild(pad);
  return pad;
}

const ghosts = () => Array.from(document.querySelectorAll('[data-aito-flight-layer] > *'));
const travelOf = (ghost: Element) => recorded.find((entry) => entry.el === ghost)!;

const SLOT_A: Box = { left: 20, top: 40, width: 280, height: 120 };
const SLOT_B: Box = { left: 340, top: 40, width: 280, height: 120 };

beforeEach(() => {
  stubAnimate();
  options = { suspended: false, departureTarget: () => null };
});

afterEach(() => {
  document.body.innerHTML = '';
  delete (Element.prototype as { animate?: unknown }).animate;
});

describe('useCardFlight', () => {
  it('flies a card that changed column, from where it was to where it landed', () => {
    const { board, left, right } = buildBoard();
    const card = buildCard('12', SLOT_A);
    left.appendChild(card);

    const { rerender } = renderHook(() => useCardFlight({ current: board }, options));

    right.appendChild(card);
    place(card, SLOT_B);
    rerender();

    expect(ghosts()).toHaveLength(1);
    const travel = travelOf(ghosts()[0]);
    expect(travel.keyframes[0].transform).toBe('translate(0px, 0px)');
    expect(travel.keyframes[1].transform).toBe('translate(320px, 0px)');
  });

  it('holds the real card invisible in its new slot while the ghost is in the air', () => {
    const { board, left, right } = buildBoard();
    const card = buildCard('12', SLOT_A);
    left.appendChild(card);
    const { rerender } = renderHook(() => useCardFlight({ current: board }, options));

    right.appendChild(card);
    place(card, SLOT_B);
    rerender();

    // Invisible, but still occupying its slot — the destination column's
    // reflow opens the gap while the ghost travels, so the card lands into a
    // space that is already waiting for it.
    expect(card.style.opacity).toBe('0');
  });

  it('ignores a move within one column — that is useColumnReflow', () => {
    const { board, left } = buildBoard();
    const card = buildCard('12', SLOT_A);
    left.appendChild(card);
    const { rerender } = renderHook(() => useCardFlight({ current: board }, options));

    place(card, { ...SLOT_A, top: 200 });
    rerender();

    expect(ghosts()).toHaveLength(0);
  });

  it('ignores a card it has never seen — an arrival to the board is an entrance', () => {
    const { board, left } = buildBoard();
    const { rerender } = renderHook(() => useCardFlight({ current: board }, options));

    left.appendChild(buildCard('12', SLOT_A));
    rerender();

    expect(ghosts()).toHaveLength(0);
  });

  it('records positions while suspended, so lifting the suspension replays nothing', () => {
    const { board, left, right } = buildBoard();
    const card = buildCard('12', SLOT_A);
    left.appendChild(card);
    options = { suspended: true };
    const { rerender } = renderHook(() => useCardFlight({ current: board }, options));

    right.appendChild(card);
    place(card, SLOT_B);
    rerender();
    expect(ghosts()).toHaveLength(0);

    options = { ...options, suspended: false };
    rerender();
    expect(ghosts()).toHaveLength(0);
  });

  it('flies nothing under prefers-reduced-motion', () => {
    const realMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    })) as typeof window.matchMedia;

    try {
      const { board, left, right } = buildBoard();
      const card = buildCard('12', SLOT_A);
      left.appendChild(card);
      const { rerender } = renderHook(() => useCardFlight({ current: board }, options));

      right.appendChild(card);
      place(card, SLOT_B);
      rerender();

      expect(ghosts()).toHaveLength(0);
      expect(card.style.opacity).toBe('');
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });

  it('flies nothing for a card that was scrolled out of sight — there was no departure to see', () => {
    const { board, left, right } = buildBoard();
    const card = buildCard('12', { left: 20, top: 2000, width: 280, height: 120 });
    left.appendChild(card);
    const { rerender } = renderHook(() => useCardFlight({ current: board }, options));

    right.appendChild(card);
    place(card, SLOT_B);
    rerender();

    expect(ghosts()).toHaveLength(0);
  });

  it('strips the ghost of every attribute another system queries', () => {
    const { board, left, right } = buildBoard();
    const card = buildCard('12', SLOT_A);
    left.appendChild(card);
    const { rerender } = renderHook(() => useCardFlight({ current: board }, options));

    right.appendChild(card);
    place(card, SLOT_B);
    rerender();

    const ghost = ghosts()[0];
    // useCardMorph finds the card to morph the detail panel into by
    // [data-aito-card-id]; a ghost carrying it would be a second match.
    expect(ghost.querySelector('[data-aito-card-id]')).toBeNull();
    expect(ghost.getAttribute('data-flip-key')).toBeNull();
    expect(ghost.className).toBe('');
  });

  it('retargets an interrupted flight instead of stacking a second ghost', () => {
    const { board, left, right } = buildBoard();
    const card = buildCard('12', SLOT_A);
    left.appendChild(card);
    const { rerender } = renderHook(() => useCardFlight({ current: board }, options));

    right.appendChild(card);
    place(card, SLOT_B);
    rerender();

    left.appendChild(card);
    place(card, SLOT_A);
    rerender();

    expect(ghosts()).toHaveLength(1);
  });

  it('forgets the board while it is unmounted, so coming back flies nothing', () => {
    const first = buildBoard();
    const card = buildCard('12', SLOT_A);
    first.left.appendChild(card);
    let current: HTMLElement | null = first.board;
    const { rerender } = renderHook(() => useCardFlight({ current }, options));

    // The Done view replaces the board: every column element is gone.
    current = null;
    rerender();

    // Back to the board — freshly mounted columns, same cards.
    document.body.innerHTML = '';
    const second = buildBoard();
    second.right.appendChild(buildCard('12', SLOT_B));
    current = second.board;
    rerender();

    expect(ghosts()).toHaveLength(0);
  });

  it('leaves nothing behind when it unmounts', () => {
    const { board, left, right } = buildBoard();
    const card = buildCard('12', SLOT_A);
    left.appendChild(card);
    const { rerender, unmount } = renderHook(() => useCardFlight({ current: board }, options));

    right.appendChild(card);
    place(card, SLOT_B);
    rerender();
    expect(ghosts()).toHaveLength(1);

    unmount();

    expect(document.querySelector('[data-aito-flight-layer]')).toBeNull();
    expect(card.style.opacity).toBe('');
  });
});

describe('flightDuration', () => {
  it('scales with distance between the two slots', () => {
    // One column over (~330px) lands near 350ms — quick, but not a blink.
    expect(flightDuration(330, 0)).toBeCloseTo(280 + 330 * 0.22, 5);
  });

  it('never dips below the floor or past the ceiling', () => {
    expect(flightDuration(0, 0)).toBe(280);
    expect(flightDuration(4000, 0)).toBe(560);
  });
});

describe('useCardFlight departures', () => {
  it('flies a card that went to Done into the archive toggle', async () => {
    const { board, left } = buildBoard();
    const pad = buildArchivePad();
    const card = buildCard('12', SLOT_A);
    left.appendChild(card);
    options = { ...options, departureTarget: () => 'archive' };
    const { rerender } = renderHook(() => useCardFlight({ current: board }, options));

    card.remove();
    rerender();

    expect(ghosts()).toHaveLength(1);
    const travel = travelOf(ghosts()[0]);
    // Centre to centre: 900 + 80 - (20 + 140) = 820 across, 0 + 20 - (40 + 60)
    // = -80 up. The shrink converges on the button, not on its corner.
    expect(travel.keyframes[1].transform).toBe('translate(820px, -80px)');

    // The receipt fires when the ghost LANDS, which is one microtask behind
    // the stub's already-resolved `finished` — every other assertion in this
    // file is synchronous precisely so it observes the flight mid-air.
    await Promise.resolve();
    expect(recorded.some((entry) => entry.el === pad)).toBe(true);
  });

  it('shrinks and fades the ghost out rather than landing it at full size', () => {
    const { board, left } = buildBoard();
    buildArchivePad();
    const card = buildCard('12', SLOT_A);
    left.appendChild(card);
    options = { ...options, departureTarget: () => 'archive' };
    const { rerender } = renderHook(() => useCardFlight({ current: board }, options));

    card.remove();
    rerender();

    const face = ghosts()[0].querySelector('[data-aito-card]')!;
    const lift = recorded.find((entry) => entry.el === face)!;
    // Full opacity past the halfway mark, so you read WHAT went in rather than
    // merely that something did.
    expect(lift.keyframes[1]).toMatchObject({ offset: 0.55, opacity: 1 });
    expect(lift.keyframes[2]).toMatchObject({ transform: 'scale(0.28)', opacity: 0 });
  });

  it('flies nothing for a card that left for anywhere else', () => {
    const { board, left } = buildBoard();
    buildArchivePad();
    const card = buildCard('12', SLOT_A);
    left.appendChild(card);
    // Deleted, or filtered out by the search box: it did NOT go to the
    // archive, and flying it into that button would say something false.
    const { rerender } = renderHook(() => useCardFlight({ current: board }, options));

    card.remove();
    rerender();

    expect(ghosts()).toHaveLength(0);
  });

  it('flies nothing when there is no archive toggle to fly into', () => {
    const { board, left } = buildBoard();
    const card = buildCard('12', SLOT_A);
    left.appendChild(card);
    options = { ...options, departureTarget: () => 'archive' };
    const { rerender } = renderHook(() => useCardFlight({ current: board }, options));

    card.remove();
    rerender();

    expect(ghosts()).toHaveLength(0);
  });
});

/** jsdom has no layout, so the scroller's own numbers have to be declared. */
function makeScrollable(board: HTMLElement, scrollWidth: number) {
  Object.defineProperty(board, 'scrollWidth', { value: scrollWidth, configurable: true });
  Object.defineProperty(board, 'clientWidth', { value: 1200, configurable: true });
  Object.defineProperty(board, 'scrollLeft', { value: 0, writable: true, configurable: true });
}

describe('useCardFlight pan', () => {
  it('pans the board to reveal a destination past its right edge, on the flight’s own timeline', () => {
    const { board, left, right } = buildBoard();
    makeScrollable(board, 2400);
    const card = buildCard('12', SLOT_A);
    left.appendChild(card);
    const { rerender } = renderHook(() => useCardFlight({ current: board }, options));

    // Lands 100px past the board's right edge (1200), so the board must
    // travel 100 + 16 of margin.
    right.appendChild(card);
    place(card, { left: 1020, top: 40, width: 280, height: 120 });
    rerender();

    expect(board.scrollLeft).toBe(116);
    // The landing point is expressed in post-pan coordinates, so the ghost
    // and the board settle on the same frame instead of the card overshooting
    // by exactly the pan.
    const travel = travelOf(ghosts()[0]);
    expect(travel.keyframes[1].transform).toBe('translate(884px, 0px)');
  });

  it('does not pan for a destination already in view', () => {
    const { board, left, right } = buildBoard();
    makeScrollable(board, 2400);
    const card = buildCard('12', SLOT_A);
    left.appendChild(card);
    const { rerender } = renderHook(() => useCardFlight({ current: board }, options));

    right.appendChild(card);
    place(card, SLOT_B);
    rerender();

    expect(board.scrollLeft).toBe(0);
    expect(travelOf(ghosts()[0]).keyframes[1].transform).toBe('translate(320px, 0px)');
  });

  it('never pans past the end of the scroller', () => {
    const { board, left, right } = buildBoard();
    // Only 60px of scrollable range exists, so a 116px pan is clamped to it.
    makeScrollable(board, 1260);
    const card = buildCard('12', SLOT_A);
    left.appendChild(card);
    const { rerender } = renderHook(() => useCardFlight({ current: board }, options));

    right.appendChild(card);
    place(card, { left: 1020, top: 40, width: 280, height: 120 });
    rerender();

    expect(board.scrollLeft).toBe(60);
  });
});
