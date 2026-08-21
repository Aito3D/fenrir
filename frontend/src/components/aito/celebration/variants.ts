import { makeParticle, type Particle, type Rng, type Vec } from './particles';
import { pick, type Palette } from './palette';

/** The celebration emitters — one function per proposition.
 *
 *  Every one of them is a pure `(context, rng) => Particle[]`: no canvas, no
 *  clock, no DOM. A variant describes what is BORN at t=0 and nothing else;
 *  anything that has to happen later happens through `onDeath` (a particle
 *  whose death is an event — the shell that bursts, the delay that fires a
 *  second shell) or `onUpdate` (a particle that emits while it lives — the
 *  comet's trail). That constraint is what keeps timing physical: a burst
 *  happens where the shell actually got to, not where a timer guessed it
 *  would be.
 *
 *  Numbers here are tuned against the app's dark board at 1× zoom. The two
 *  that carry the feel of each effect are `drag` — how fast the air kills the
 *  motion, which is the entire difference between fireworks and confetti —
 *  and `ttl`, which is the only thing standing between a celebration and an
 *  interruption. Nothing here runs longer than 2.4s. */

export type CelebrationVariant = 'firework' | 'confetti' | 'bloom' | 'comet' | 'embers';

export interface EmitContext {
  /** Where the celebration starts: the centre of the card being archived. */
  origin: Vec;
  /** Where it should END, when the effect travels — the Show Done toggle.
   *  `null` when that target is not on screen. */
  target: Vec | null;
  width: number;
  height: number;
  palette: Palette;
}

/** Random inside a range. */
function between(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** A particle that does nothing, exists for `delay` seconds, and then spawns.
 *
 *  The engine has no timer, on purpose — a scheduler would be a second clock
 *  to keep in sync with the frame loop. A dead-on-arrival carrier gives the
 *  same thing for free: it ages with everything else, so a paused tab pauses
 *  the delay too. */
function delayed(at: Vec, delay: number, spawn: (rng: Rng) => Particle[]): Particle {
  return makeParticle({ x: at.x, y: at.y, ttl: delay, size: 0, onDeath: (_p, rng) => spawn(rng) });
}

/** The white-hot flash at the centre of any impact. Very short — it is the
 *  eye's cue that something happened, and holding it past ~250ms turns a
 *  detonation into a lamp. */
function flash(at: Vec, palette: Palette, size: number, ttl = 0.22): Particle {
  return makeParticle({
    x: at.x,
    y: at.y,
    shape: 'glow',
    size,
    ttl,
    color: palette.hot,
  });
}

/* ------------------------------------------------------------------ */
/* 1. Firework — a launched shell that bursts overhead.                */
/* ------------------------------------------------------------------ */

function crackle(p: Particle, rng: Rng, palette: Palette): Particle[] {
  // Only some sparks crackle. All of them would double the particle count for
  // an effect whose charm is that it is intermittent.
  if (rng() > 0.28) return [];
  return Array.from({ length: 3 }, () => {
    const angle = rng() * Math.PI * 2;
    const speed = between(rng, 30, 90);
    return makeParticle({
      x: p.x,
      y: p.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      ttl: between(rng, 0.18, 0.32),
      size: 1.1,
      color: palette.hot,
      gravity: 220,
      drag: 2.4,
      flicker: 0.7,
      seed: rng() * 10,
    });
  });
}

function burst(at: Vec, palette: Palette, rng: Rng, scale: number): Particle[] {
  const count = Math.round(74 * scale);
  const colors = [palette.accent, palette.accent, palette.accentLight, palette.hot, palette.gold];

  const sparks = Array.from({ length: count }, () => {
    const angle = rng() * Math.PI * 2;
    // A real shell throws its stars at one speed, so the front is a ring; the
    // 0.55 floor keeps a few stragglers inside it, which is what stops the
    // burst looking like a stamped circle.
    const speed = between(rng, 0.55, 1) * 380 * scale;
    return makeParticle({
      x: at.x,
      y: at.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      // Low gravity, high drag: the stars stop almost at once and then sag.
      // That hang is the shape everyone recognises — ballistics alone gives a
      // fountain, not a firework.
      gravity: 300,
      drag: 1.9,
      ttl: between(rng, 0.85, 1.55),
      size: between(rng, 1.7, 2.6),
      color: pick(colors, rng),
      trail: 0.05,
      flicker: 0.45,
      seed: rng() * 10,
      onDeath: (p, r) => crackle(p, r, palette),
    });
  });

  return [
    flash(at, palette, 26 * scale),
    makeParticle({
      x: at.x,
      y: at.y,
      shape: 'ring',
      size: 6,
      grow: 460 * scale,
      ttl: 0.32,
      color: palette.accentLight,
    }),
    ...sparks,
  ];
}

/** Sparks shed by a climbing shell — the smoke trail's hot bits, falling
 *  away behind it. Emitted at a fixed rate per second, so the trail is the
 *  same density whatever the display refresh rate is. */
function shellTrail(p: Particle, dt: number, rng: Rng, palette: Palette, budget: { left: number }): Particle[] {
  const rate = 70;
  const n = Math.min(budget.left, Math.floor(dt * rate + rng()));
  if (n <= 0) return [];
  budget.left -= n;
  return Array.from({ length: n }, () =>
    makeParticle({
      x: p.x + between(rng, -2, 2),
      y: p.y + between(rng, -2, 2),
      vx: between(rng, -30, 30),
      vy: between(rng, -10, 60),
      ttl: between(rng, 0.2, 0.45),
      size: between(rng, 0.9, 1.6),
      color: rng() > 0.5 ? palette.gold : palette.hot,
      gravity: 160,
      drag: 1.4,
      flicker: 0.6,
      seed: rng() * 10,
    }),
  );
}

function shell(from: Vec, palette: Palette, rng: Rng, scale: number): Particle {
  const budget = { left: 40 };
  return makeParticle({
    x: from.x,
    y: from.y,
    vx: between(rng, -70, 70),
    // Tuned with the gravity and ttl below so the shell climbs ~240px and
    // bursts just before its apex, while it is still visibly rising. Bursting
    // AT the apex reads as the shell stalling.
    vy: -between(rng, 690, 810) * scale,
    gravity: 950,
    drag: 0.25,
    ttl: between(rng, 0.5, 0.6),
    size: 2.2,
    color: palette.hot,
    trail: 0.045,
    flicker: 0.3,
    seed: rng() * 10,
    onUpdate: (p, dt, r) => shellTrail(p, dt, r, palette, budget),
    onDeath: (p, r) => burst({ x: p.x, y: p.y }, palette, r, scale),
  });
}

function firework({ origin, palette }: EmitContext, rng: Rng): Particle[] {
  // Two shells, the second smaller, offset and late. One shell is an event;
  // two are a celebration — and the 180ms gap is what makes it read as a
  // display rather than as a double-click.
  const second = { x: origin.x + between(rng, -90, 90), y: origin.y };
  return [
    shell(origin, palette, rng, 1),
    delayed(second, 0.18, (r) => [shell(second, palette, r, 0.72)]),
  ];
}

/* ------------------------------------------------------------------ */
/* 2. Confetti — a paper cannon fired from the card.                   */
/* ------------------------------------------------------------------ */

function confetti({ origin, palette }: EmitContext, rng: Rng): Particle[] {
  const ribbons = Array.from({ length: 88 }, () => {
    // A cone pointing up, ±55° off vertical: wide enough to fill the space
    // above the card, narrow enough to still read as fired FROM it.
    const angle = -Math.PI / 2 + between(rng, -0.96, 0.96);
    const speed = between(rng, 380, 780);
    return makeParticle({
      x: origin.x + between(rng, -10, 10),
      y: origin.y + between(rng, -6, 6),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      // Heavy gravity against modest drag: paper reaches its apex fast and
      // then falls at a near-constant speed, which is the give-away that a
      // thing is light and flat rather than small and dense.
      gravity: 1250,
      drag: 1.15,
      ttl: between(rng, 1.5, 2.3),
      size: between(rng, 4.2, 6.6),
      color: pick(palette.confetti, rng),
      shape: 'ribbon',
      rot: rng() * Math.PI,
      vrot: between(rng, -9, 9),
      flutter: between(rng, 6, 12),
      seed: rng() * 10,
    });
  });

  // The muzzle: a flash and a handful of hot sparks. Without them the paper
  // appears out of nowhere; with them, something fired it.
  const sparks = Array.from({ length: 14 }, () => {
    const angle = -Math.PI / 2 + between(rng, -0.8, 0.8);
    const speed = between(rng, 500, 900);
    return makeParticle({
      x: origin.x,
      y: origin.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      gravity: 700,
      drag: 2.6,
      ttl: between(rng, 0.3, 0.5),
      size: 1.8,
      color: rng() > 0.5 ? palette.hot : palette.gold,
      trail: 0.05,
      flicker: 0.4,
      seed: rng() * 10,
    });
  });

  return [flash(origin, palette, 18, 0.18), ...sparks, ...ribbons];
}

/* ------------------------------------------------------------------ */
/* 3. Bloom — one shockwave, 600ms, and then nothing.                  */
/* ------------------------------------------------------------------ */

function bloom({ origin, palette }: EmitContext, rng: Rng): Particle[] {
  const sparks = Array.from({ length: 26 }, () => {
    const angle = rng() * Math.PI * 2;
    const speed = between(rng, 220, 350);
    return makeParticle({
      x: origin.x,
      y: origin.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      // Very high drag: every spark is fully stopped inside 150ms, so the
      // effect ends where it began instead of raining down the page.
      gravity: 60,
      drag: 3.4,
      ttl: between(rng, 0.32, 0.5),
      size: between(rng, 1.4, 2),
      color: rng() > 0.45 ? palette.accentLight : palette.hot,
      trail: 0.045,
      seed: rng() * 10,
    });
  });

  return [
    flash(origin, palette, 20, 0.25),
    makeParticle({ x: origin.x, y: origin.y, shape: 'ring', size: 4, grow: 540, ttl: 0.5, color: palette.accentLight }),
    // A second, slower ring 80ms behind the first. One ring is a bubble; two
    // at different speeds read as a wave with a front and a body.
    delayed(origin, 0.08, () => [
      makeParticle({ x: origin.x, y: origin.y, shape: 'ring', size: 2, grow: 360, ttl: 0.42, color: palette.accent }),
    ]),
    ...sparks,
  ];
}

/* ------------------------------------------------------------------ */
/* 4. Comet — the card's spirit flies to the archive.                  */
/* ------------------------------------------------------------------ */

function cometTrail(p: Particle, dt: number, rng: Rng, palette: Palette): Particle[] {
  const n = Math.floor(dt * 110 + rng());
  const colors = [palette.accent, palette.accentLight, palette.hot, palette.gold];
  return Array.from({ length: n }, () =>
    makeParticle({
      x: p.x + between(rng, -3, 3),
      y: p.y + between(rng, -3, 3),
      // A little of the head's own velocity, so the trail spreads BEHIND the
      // comet rather than beading along its path like a dotted line.
      vx: p.vx * 0.12 + between(rng, -60, 60),
      vy: p.vy * 0.12 + between(rng, -60, 60),
      gravity: 120,
      drag: 2.6,
      ttl: between(rng, 0.32, 0.62),
      size: between(rng, 1.3, 2.2),
      color: pick(colors, rng),
      flicker: 0.45,
      seed: rng() * 10,
    }),
  );
}

function comet({ origin, target, width, palette }: EmitContext, rng: Rng): Particle[] {
  // With no archive button on screen there is nowhere to fly to, so the comet
  // arcs to the top edge instead — off toward where the archive lives — which
  // still reads as "it went away" rather than as a burst that missed.
  const destination = target ?? { x: Math.min(width - 60, origin.x + 260), y: 60 };
  // Control point pulled well above the straight line: a Bézier that bulges
  // is a throw, a straight one is a laser. Jittered so archiving three cards
  // in a row does not trace the same arc three times.
  const control = {
    x: (origin.x + destination.x) / 2 + between(rng, -40, 40),
    y: Math.min(origin.y, destination.y) - between(rng, 150, 200),
  };

  const head = makeParticle({
    x: origin.x,
    y: origin.y,
    ttl: 0.82,
    size: 3,
    color: palette.hot,
    trail: 0.05,
    path: { p0: origin, c: control, p1: destination },
    onUpdate: (p, dt, r) => cometTrail(p, dt, r, palette),
    onDeath: (p, r) => [
      flash({ x: p.x, y: p.y }, palette, 16, 0.2),
      makeParticle({ x: p.x, y: p.y, shape: 'ring', size: 3, grow: 300, ttl: 0.36, color: palette.accentLight }),
      // The arrival pop is small on purpose: the journey is the effect, and a
      // full burst on the toolbar button would pull the eye off the board and
      // onto a piece of chrome.
      ...Array.from({ length: 20 }, () => {
        const angle = r() * Math.PI * 2;
        const speed = between(r, 110, 260);
        return makeParticle({
          x: p.x,
          y: p.y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          gravity: 240,
          drag: 3,
          ttl: between(r, 0.35, 0.6),
          size: between(r, 1.3, 2),
          color: r() > 0.5 ? palette.accentLight : palette.hot,
          trail: 0.04,
          flicker: 0.4,
          seed: r() * 10,
        });
      }),
    ],
  });

  return [flash(origin, palette, 14, 0.18), head];
}

/* ------------------------------------------------------------------ */
/* 5. Embers — the card burns off, warm and slow.                      */
/* ------------------------------------------------------------------ */

function embers({ origin, palette }: EmitContext, rng: Rng): Particle[] {
  const colors = [palette.accent, palette.gold, palette.hot];

  const rising = Array.from({ length: 36 }, () =>
    makeParticle({
      x: origin.x + between(rng, -70, 70),
      y: origin.y + between(rng, -18, 18),
      vx: between(rng, -40, 40),
      vy: -between(rng, 40, 150),
      // NEGATIVE gravity: hot air is buoyant, and an ember that arcs back
      // down is ash. This is the one place in the engine where the physics is
      // deliberately wrong in service of what the thing actually looks like.
      gravity: -60,
      drag: 0.55,
      ttl: between(rng, 1.5, 2.4),
      size: between(rng, 1.5, 3),
      color: pick(colors, rng),
      shape: 'glow',
      flicker: 0.55,
      fadeIn: 0.12,
      seed: rng() * 10,
      onUpdate: (p, dt) => {
        // A slow horizontal wander. Embers in still air never travel straight
        // up, and the sine is enough to break the columns that otherwise form.
        p.vx += Math.sin(p.age * 2.4 + p.seed) * 34 * dt;
      },
    }),
  );

  const impact = Array.from({ length: 12 }, () => {
    const angle = -Math.PI / 2 + between(rng, -1.5, 1.5);
    const speed = between(rng, 180, 420);
    return makeParticle({
      x: origin.x,
      y: origin.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      gravity: 120,
      drag: 2.8,
      ttl: between(rng, 0.35, 0.6),
      size: 1.7,
      color: palette.gold,
      trail: 0.05,
      flicker: 0.5,
      seed: rng() * 10,
    });
  });

  return [flash(origin, palette, 16, 0.28), ...impact, ...rising];
}

export const VARIANTS: Record<CelebrationVariant, (ctx: EmitContext, rng: Rng) => Particle[]> = {
  firework,
  confetti,
  bloom,
  comet,
  embers,
};
