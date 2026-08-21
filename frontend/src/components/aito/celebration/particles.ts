/** The celebration engine's physics core: what a particle is, and what one
 *  frame does to a list of them.
 *
 *  Deliberately free of DOM, canvas and React — `step` is a pure function of
 *  (particles, dt, rng), which is the whole reason the engine is testable at
 *  all. Everything that draws lives in `render.ts`; everything that decides
 *  what to spawn lives in `variants.ts`.
 *
 *  Coordinates are viewport pixels (the layer canvas is fixed and full-screen),
 *  velocities px/s and accelerations px/s². Time is seconds everywhere, never
 *  frames: a burst must look identical on a 60Hz and a 120Hz display, and the
 *  only way to get that is to integrate against real elapsed time. */

/** Injected randomness. The variants take one so a test can hand them a
 *  deterministic sequence and assert on the particles that come out. */
export type Rng = () => number;

export interface Vec {
  x: number;
  y: number;
}

export type ParticleShape =
  /** A streaking point of light — firework sparks, comet trail. Additive. */
  | 'spark'
  /** A flat tumbling rectangle — confetti. Opaque, drawn source-over. */
  | 'ribbon'
  /** A soft round glow with no streak — embers, the bloom's flash. Additive. */
  | 'glow'
  /** An expanding hollow circle — the shockwave. Additive. */
  | 'ring';

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Seconds lived. `age >= ttl` is the one death condition. */
  age: number;
  /** Seconds to live. */
  ttl: number;
  /** Radius for round shapes, half-width for a ribbon. */
  size: number;
  /** Any CSS colour string; `render` caches a sprite per distinct value, so
   *  variants should pick from a small fixed palette rather than generating a
   *  colour per particle. */
  color: string;
  gravity: number;
  /** Air resistance per second, applied as `v *= exp(-drag * dt)`.
   *  Exponential rather than linear so the decay is frame-rate independent —
   *  a linear `v -= v * drag * dt` diverges once dt gets big enough, which is
   *  exactly what happens on the first frame after a stalled tab. */
  drag: number;
  shape: ParticleShape;
  /** Ribbons: current rotation and its rate, radians. */
  rot: number;
  vrot: number;
  /** Ribbons: how fast the strip tumbles edge-on, radians/s. Drawn as a
   *  horizontal squash, which is what sells a flat object turning in 3D
   *  without any 3D. */
  flutter: number;
  /** Sparks: how many seconds of past motion to smear behind the head. The
   *  streak is drawn from the CURRENT velocity, so a spark that is slowing
   *  down shortens on its own — no separate length animation needed. */
  trail: number;
  /** 0..1 twinkle depth. Firework sparks that hold a flat brightness read as
   *  plastic; real ones scintillate. */
  flicker: number;
  /** Per-particle phase, so flickers don't beat in unison. */
  seed: number;
  /** Rings: radius growth in px/s. */
  grow: number;
  /** Fraction of ttl spent fading in. 0 means the particle is born at full
   *  brightness, which is right for anything struck into existence (sparks)
   *  and wrong for anything that arrives (embers drifting in). */
  fadeIn: number;
  /** Overrides the physics integration entirely: position is read off a
   *  quadratic Bézier by eased progress instead. Used by the comet head,
   *  which has to ARRIVE somewhere exactly — ballistics can only be aimed. */
  path?: { p0: Vec; c: Vec; p1: Vec };
  /** Children spawned at the moment of death, at wherever the particle
   *  actually got to. This is what makes a firework a firework: the shell is
   *  a particle whose death is the burst, so the burst inherits the shell's
   *  real position and drift instead of guessing at them. */
  onDeath?: (p: Particle, rng: Rng) => Particle[];
  /** Children spawned during life — a continuous emitter (the comet's trail).
   *  Called once per frame with the frame's dt so emission rate stays
   *  time-based, not frame-based. */
  onUpdate?: (p: Particle, dt: number, rng: Rng) => Particle[] | void;
}

/** A particle with every field defaulted: inert, invisible, dead on arrival.
 *  Variants override only what they mean, which keeps an emitter readable as
 *  a description of the effect rather than a wall of zeroes. */
export function makeParticle(overrides: Partial<Particle> & Pick<Particle, 'x' | 'y'>): Particle {
  return {
    vx: 0,
    vy: 0,
    age: 0,
    ttl: 1,
    size: 2,
    color: '#fff',
    gravity: 0,
    drag: 0,
    shape: 'spark',
    rot: 0,
    vrot: 0,
    flutter: 0,
    trail: 0,
    flicker: 0,
    seed: 0,
    grow: 0,
    fadeIn: 0,
    ...overrides,
  };
}

/** Progress through life, 0..1. */
export function progress(p: Particle): number {
  return p.ttl <= 0 ? 1 : Math.min(1, p.age / p.ttl);
}

/** Opacity for this frame: a fade-in ramp, a quadratic fade-out (linear reads
 *  as a hard cut at the end because the eye is not linear in brightness), and
 *  the twinkle on top. Never returns above 1 — additive blending turns
 *  overshoot into white blobs. */
export function alphaOf(p: Particle, clock: number): number {
  const t = progress(p);
  const out = 1 - t * t;
  const inn = p.fadeIn > 0 ? Math.min(1, t / p.fadeIn) : 1;
  const twinkle = p.flicker > 0 ? 1 - p.flicker * (0.5 + 0.5 * Math.sin(clock * 34 + p.seed * 11)) : 1;
  return Math.max(0, Math.min(1, out * inn * twinkle));
}

/** Cubic ease-out, the arrival curve for path-driven particles. */
function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}

function bezier(path: NonNullable<Particle['path']>, t: number): Vec {
  const u = 1 - t;
  return {
    x: u * u * path.p0.x + 2 * u * t * path.c.x + t * t * path.p1.x,
    y: u * u * path.p0.y + 2 * u * t * path.c.y + t * t * path.p1.y,
  };
}

/** The largest timestep the integrator will accept, in seconds.
 *
 *  A backgrounded tab, a long paint, or a breakpoint all hand rAF a gap of
 *  hundreds of ms. Integrating that literally teleports every particle off
 *  screen in one frame, so the burst "disappears" the moment anything stutters.
 *  Clamping makes the animation run briefly in slow motion instead, which
 *  nobody notices. */
const MAX_DT = 1 / 30;

/** Advance one frame. Returns the surviving particles plus everything spawned
 *  this frame, ordered so that children are drawn over their parents.
 *
 *  Pure: no allocation of randomness, no clock reads, no canvas. The caller
 *  owns dt and the rng, which is what lets a test run 90 deterministic frames
 *  in a millisecond. */
export function step(particles: Particle[], dtRaw: number, rng: Rng): Particle[] {
  const dt = Math.min(Math.max(dtRaw, 0), MAX_DT);
  const next: Particle[] = [];
  const spawned: Particle[] = [];

  for (const p of particles) {
    p.age += dt;

    if (p.age >= p.ttl) {
      // Death first, and only once: the particle is not pushed to `next`, so
      // nothing can resurrect it or fire `onDeath` twice.
      if (p.onDeath) spawned.push(...p.onDeath(p, rng));
      continue;
    }

    if (p.path) {
      const { x, y } = bezier(p.path, easeOut(progress(p)));
      // Velocity is still maintained, because the trail is drawn from it —
      // a path particle with zero velocity would streak zero pixels.
      p.vx = dt > 0 ? (x - p.x) / dt : 0;
      p.vy = dt > 0 ? (y - p.y) / dt : 0;
      p.x = x;
      p.y = y;
    } else {
      p.vy += p.gravity * dt;
      if (p.drag > 0) {
        const keep = Math.exp(-p.drag * dt);
        p.vx *= keep;
        p.vy *= keep;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }

    p.rot += p.vrot * dt;

    if (p.onUpdate) {
      const children = p.onUpdate(p, dt, rng);
      if (children) spawned.push(...children);
    }

    next.push(p);
  }

  return next.concat(spawned);
}

/** Hard ceiling on live particles.
 *
 *  Not a performance guess — a correctness bound. Every variant here spawns
 *  well under it, but `onDeath` chains are recursive by construction and a
 *  celebration triggered twice in a second stacks; without a cap a bug in one
 *  emitter degrades the whole page instead of just looking wrong. Excess
 *  spawns are dropped, never queued: a dropped spark is invisible, a queued
 *  one arrives late and looks like a glitch. */
export const MAX_PARTICLES = 1200;

export function capped(particles: Particle[]): Particle[] {
  return particles.length <= MAX_PARTICLES ? particles : particles.slice(0, MAX_PARTICLES);
}
