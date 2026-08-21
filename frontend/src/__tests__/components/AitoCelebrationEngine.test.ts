/**
 * The Done celebration's physics core.
 *
 * The engine is a pure function of (particles, dt, rng) precisely so that the
 * things that can silently rot in a particle system — a `ttl` that never
 * expires, an `onDeath` that fires twice, a burst that teleports off screen
 * after a stalled frame — are assertable without a canvas or a clock.
 *
 * What is deliberately NOT tested here is how any of it looks. The numbers in
 * `variants.ts` are art; the contract they run on is not.
 */

import { describe, it, expect, vi } from 'vitest';
import { alphaOf, capped, makeParticle, step, MAX_PARTICLES, type Particle } from '../../components/aito/celebration/particles';
import { VARIANTS } from '../../components/aito/celebration/variants';
import { readPalette } from '../../components/aito/celebration/palette';

/** A deterministic rng: the same sequence every run, so a variant's output is
 *  reproducible and a failure is a real failure rather than an unlucky draw. */
function seeded(seed = 1): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const rng = () => 0.5;

/** One frame at 60Hz. Every advance in this file is a whole number of real
 *  frames, because `step` clamps anything longer than 1/30 (see the huge-dt
 *  test below) — a test that hands it 0.5 is not testing the engine anyone
 *  runs. */
const FRAME = 1 / 60;

/** Advance `seconds` worth of 60Hz frames, the way the rAF loop does. */
function advance(particles: Particle[], seconds: number): Particle[] {
  let live = particles;
  for (let t = 0; t < seconds - 1e-9; t += FRAME) live = step(live, FRAME, rng);
  return live;
}

describe('celebration engine — integration', () => {
  it('moves a particle by its velocity', () => {
    const p = makeParticle({ x: 0, y: 0, vx: 100, vy: -50, ttl: 10 });
    advance([p], 0.1);
    expect(p.x).toBeCloseTo(10, 5);
    expect(p.y).toBeCloseTo(-5, 5);
  });

  it('applies gravity before moving, so a falling particle accelerates', () => {
    const p = makeParticle({ x: 0, y: 0, gravity: 1000, ttl: 10 });
    advance([p], 0.1);
    expect(p.vy).toBeCloseTo(100, 5);
    advance([p], 0.1);
    expect(p.vy).toBeCloseTo(200, 5);
  });

  it('decays velocity exponentially, so the result is frame-rate independent', () => {
    // The whole reason drag is `exp(-k*dt)` and not `v -= v*k*dt`: one 100ms
    // step and ten 10ms steps must land in the same place, or a burst looks
    // different on a 60Hz and a 120Hz display.
    const coarse = makeParticle({ x: 0, y: 0, vx: 400, drag: 2, ttl: 10 });
    const fine = makeParticle({ x: 0, y: 0, vx: 400, drag: 2, ttl: 10 });
    // 30Hz against 120Hz, over the same tenth of a second.
    for (let i = 0; i < 3; i++) step([coarse], 1 / 30, rng);
    for (let i = 0; i < 12; i++) step([fine], 1 / 120, rng);
    expect(coarse.vx).toBeCloseTo(fine.vx, 1);
  });

  it('clamps a huge dt instead of teleporting everything off screen', () => {
    // What a backgrounded tab or a long paint hands rAF. Integrated literally,
    // this particle would be 4000px away and the celebration would look like
    // it never happened.
    const p = makeParticle({ x: 0, y: 0, vx: 4000, ttl: 100 });
    step([p], 10, rng);
    expect(p.x).toBeLessThanOrEqual(4000 / 30 + 0.001);
  });
});

describe('celebration engine — lifecycle', () => {
  it('drops a particle once it outlives its ttl', () => {
    const p = makeParticle({ x: 0, y: 0, ttl: 0.1 });
    expect(advance([p], 0.09)).toHaveLength(1);
    expect(advance([p], 0.02)).toHaveLength(0);
  });

  it('fires onDeath exactly once, at the position the particle reached', () => {
    const onDeath = vi.fn((p: Particle) => [makeParticle({ x: p.x, y: p.y, ttl: 1 })]);
    const shell = makeParticle({ x: 0, y: 0, vx: 200, ttl: 0.1, onDeath });

    let live = advance([shell], 0.09);
    expect(onDeath).not.toHaveBeenCalled();

    live = advance(live, 0.02);
    expect(onDeath).toHaveBeenCalledTimes(1);
    // The burst inherits where the shell actually got to — the point of
    // hanging it off death rather than off a timer.
    expect(live).toHaveLength(1);
    // 200px/s for the ~0.1s the shell lived — not the origin, and not a
    // guess: the burst is born wherever the shell got to.
    expect(live[0].x).toBeCloseTo(20, 3);

    // Dead is dead: the shell is not in the returned list, so nothing can
    // fire its death a second time.
    advance(live, 0.1);
    expect(onDeath).toHaveBeenCalledTimes(1);
  });

  it('spawns onUpdate children while alive, and appends them after the parents', () => {
    const emitter = makeParticle({
      x: 0,
      y: 0,
      ttl: 1,
      onUpdate: () => [makeParticle({ x: 1, y: 1, ttl: 1 })],
    });
    const live = step([emitter], FRAME, rng);
    expect(live).toHaveLength(2);
    expect(live[0]).toBe(emitter);
  });

  it('walks a path particle onto its destination', () => {
    const p0 = { x: 0, y: 0 };
    const p1 = { x: 100, y: 100 };
    const p = makeParticle({ ...p0, ttl: 0.5, path: { p0, c: { x: 50, y: -50 }, p1 } });
    // One frame short of death, the eased progress is ~1 and the head is on
    // the target: a comet that stops 30px from the archive button has missed.
    advance([p], 0.49);
    expect(p.x).toBeCloseTo(100, 0);
    expect(p.y).toBeCloseTo(100, 0);
  });

  it('gives a path particle a velocity, so its trail has a direction to smear along', () => {
    const p0 = { x: 0, y: 0 };
    const p = makeParticle({ ...p0, ttl: 1, path: { p0, c: { x: 100, y: 0 }, p1: { x: 200, y: 0 } } });
    step([p], FRAME, rng);
    expect(p.vx).toBeGreaterThan(0);
  });
});

describe('celebration engine — bounds', () => {
  it('caps the live particle count', () => {
    const many = Array.from({ length: MAX_PARTICLES + 50 }, () => makeParticle({ x: 0, y: 0 }));
    expect(capped(many)).toHaveLength(MAX_PARTICLES);
  });

  it('never returns an alpha above 1, whatever the twinkle does', () => {
    const p = makeParticle({ x: 0, y: 0, ttl: 1, flicker: 1 });
    for (let clock = 0; clock < 3; clock += 0.013) {
      expect(alphaOf(p, clock)).toBeLessThanOrEqual(1);
      expect(alphaOf(p, clock)).toBeGreaterThanOrEqual(0);
    }
  });

  it('fades a particle out over its life', () => {
    const p = makeParticle({ x: 0, y: 0, ttl: 1 });
    const start = alphaOf(p, 0);
    p.age = 0.9;
    expect(alphaOf(p, 0)).toBeLessThan(start);
    p.age = 1;
    expect(alphaOf(p, 0)).toBe(0);
  });

  it('ramps a fade-in particle up from nothing', () => {
    const p = makeParticle({ x: 0, y: 0, ttl: 1, fadeIn: 0.5 });
    expect(alphaOf(p, 0)).toBe(0);
    p.age = 0.25;
    expect(alphaOf(p, 0)).toBeGreaterThan(0);
    expect(alphaOf(p, 0)).toBeLessThan(1);
  });
});

describe('celebration variants', () => {
  const context = {
    origin: { x: 400, y: 300 },
    target: null,
    width: 1200,
    height: 800,
    palette: readPalette(null),
  };

  it('every variant emits something and burns out inside 3 seconds', () => {
    for (const [name, emit] of Object.entries(VARIANTS)) {
      let live = emit(context, seeded());
      expect(live.length, name).toBeGreaterThan(0);

      // 3s of 60Hz frames. Nothing may outlive it — a celebration that is
      // still on screen when the user has moved on is not a celebration.
      for (let i = 0; i < 180; i++) live = capped(step(live, 1 / 60, seeded(i + 1)));
      expect(live, name).toHaveLength(0);
    }
  });

  it('stays under the particle cap even at the peak of the biggest variant', () => {
    let live = VARIANTS.firework(context, seeded());
    let peak = 0;
    for (let i = 0; i < 180; i++) {
      live = step(live, 1 / 60, seeded(i + 1));
      peak = Math.max(peak, live.length);
      live = capped(live);
    }
    // Under the cap with room to spare: the cap is a backstop against a bug,
    // not a budget the variants are tuned against.
    expect(peak).toBeLessThan(MAX_PARTICLES);
  });

  it('fires confetti upward out of the card', () => {
    const ribbons = VARIANTS.confetti(context, seeded()).filter((p) => p.shape === 'ribbon');
    expect(ribbons.length).toBeGreaterThan(50);
    // Canvas y grows downward, so "up" is negative. Every ribbon leaves the
    // card rising; gravity is what brings them back.
    expect(ribbons.every((p) => p.vy < 0)).toBe(true);
    expect(ribbons.every((p) => Math.abs(p.x - context.origin.x) < 40)).toBe(true);
  });

  it('sends the comet to the flight target when there is one', () => {
    const target = { x: 1000, y: 40 };
    const head = VARIANTS.comet({ ...context, target }, seeded()).find((p) => p.path);
    expect(head?.path?.p1).toEqual(target);
  });

  it('still gives the comet somewhere to go when the target is off screen', () => {
    const head = VARIANTS.comet(context, seeded()).find((p) => p.path);
    expect(head?.path?.p1).toBeDefined();
    expect(head?.path?.p1.y).toBeLessThan(context.origin.y);
  });
});
