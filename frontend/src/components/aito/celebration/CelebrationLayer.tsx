import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { capped, step, type Particle, type Vec } from './particles';
import { draw } from './render';
import { readPalette } from './palette';
import { VARIANTS, type CelebrationVariant } from './variants';
import { CelebrationContext, type Celebrate, type CelebrationOrigin } from './context';
import { useReducedMotion } from '../../../hooks/useReducedMotion';

/** The celebration's one moving part: a full-screen canvas and the frame loop
 *  that drives it.
 *
 *  Idle cost is zero, not "small". No canvas is drawn to, no rAF is
 *  scheduled, and no state changes while nothing is celebrating — the loop is
 *  started by `celebrate` and stops itself the frame the last particle dies.
 *  That matters because this mounts on a board people leave open all day. */

function centreOf(origin: CelebrationOrigin): Vec {
  return 'width' in origin
    ? { x: origin.left + origin.width / 2, y: origin.top + origin.height / 2 }
    : { x: origin.x, y: origin.y };
}

/** Where a travelling variant should land: the Show Done toggle in the board
 *  header, which already carries `data-flight-target` for `useCardFlight`'s
 *  archive flight. Reused rather than re-marked — the celebration and the
 *  card are going to the same place, and two attributes naming one target is
 *  how they end up disagreeing. */
function flightTarget(): Vec | null {
  if (typeof document === 'undefined') return null;
  const el = document.querySelector('[data-flight-target]');
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

export function CelebrationProvider({
  children,
  variant = 'firework',
}: {
  children: ReactNode;
  /** Which proposition to fire. A prop rather than a constant so the demo
   *  page can switch between them; production mounts it with one value. */
  variant?: CelebrationVariant;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** The drawing context, taken once when the canvas mounts. `getContext` is
   *  cheap but not free, and calling it inside the frame loop would be a
   *  lookup per frame for a value that never changes. `null` wherever there
   *  is no canvas implementation at all (jsdom), which turns the whole layer
   *  into a no-op instead of a crash. */
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const particlesRef = useRef<Particle[]>([]);
  const frameRef = useRef<number | null>(null);
  const clockRef = useRef(0);
  /** Canvas size in CSS pixels — what the drawing transform works in, and so
   *  what `clearRect` has to be given. `canvas.width` is the backing store and
   *  is dpr times bigger. */
  const sizeRef = useRef({ w: 0, h: 0 });
  const reducedMotion = useReducedMotion();

  // Read through a ref inside the loop: `celebrate` must keep a stable
  // identity (every card on the board holds it), and closing over the prop
  // would rebuild it — and every consumer's mutation — on each change.
  const variantRef = useRef(variant);
  variantRef.current = variant;
  const reducedRef = useRef(reducedMotion);
  reducedRef.current = reducedMotion;

  const stop = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    particlesRef.current = [];
    const ctx = ctxRef.current;
    if (ctx) ctx.clearRect(0, 0, sizeRef.current.w, sizeRef.current.h);
  }, []);

  const run = useCallback(() => {
    if (frameRef.current !== null) return;
    let last = performance.now();

    const frame = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      clockRef.current += dt;

      const ctx = ctxRef.current;
      if (!ctx) {
        frameRef.current = null;
        particlesRef.current = [];
        return;
      }

      particlesRef.current = capped(step(particlesRef.current, dt, Math.random));

      // CSS pixels, not `canvas.width`: the context carries a
      // devicePixelRatio scale (see the resize effect), so the backing-store
      // size would over-clear by that factor.
      ctx.clearRect(0, 0, sizeRef.current.w, sizeRef.current.h);
      draw(ctx, particlesRef.current, clockRef.current);

      // The whole idle-cost claim lives on this line: no particles, no next
      // frame. Nothing polls, nothing ticks in the background.
      frameRef.current = particlesRef.current.length > 0 ? requestAnimationFrame(frame) : null;
    };

    frameRef.current = requestAnimationFrame(frame);
  }, []);

  const celebrate = useCallback<Celebrate>(
    (origin, override) => {
      // The single gate for the whole feature. Someone who has asked their OS
      // for less motion gets nothing at all — not a shorter burst, not a
      // static flash.
      if (reducedRef.current) return;
      if (typeof window === 'undefined') return;

      const emit = VARIANTS[override ?? variantRef.current];
      if (!emit) return;

      const spawn = emit(
        {
          origin: centreOf(origin),
          target: flightTarget(),
          width: window.innerWidth,
          height: window.innerHeight,
          palette: readPalette(),
        },
        Math.random,
      );

      particlesRef.current = capped(particlesRef.current.concat(spawn));
      run();
    },
    [run],
  );

  // Backing store in device pixels, drawing in CSS pixels. Without the dpr
  // scale every spark is a soft blur on a retina display, which is especially
  // obvious on 1px-wide crackle.
  useEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (!ctxRef.current) ctxRef.current = canvas.getContext('2d');
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      sizeRef.current = { w: window.innerWidth, h: window.innerHeight };
      // setTransform, not scale: a resize can fire twice, and `scale` would
      // compound.
      ctxRef.current?.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  // A burst that finishes in a hidden tab should not be waiting when the user
  // comes back — rAF is already paused there, so without this the celebration
  // for something archived ten minutes ago would resume mid-air.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stop();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [stop]);

  // Turning reduced motion ON mid-flight kills what is already in the air,
  // matching how the CSS half of the motion system re-evaluates its media
  // query the moment the setting changes.
  useEffect(() => {
    if (reducedMotion) stop();
  }, [reducedMotion, stop]);

  useEffect(() => stop, [stop]);

  return (
    // `celebrate` is stable by construction (its deps never change), so the
    // context value never changes identity and no consumer re-renders.
    <CelebrationContext.Provider value={celebrate}>
      {children}
      {/* Above the detail panel (z-50) so a project finished from the panel
          is celebrated where it can be seen, but below the toasts (z-[60]):
          a decoration must never be the thing covering an error message. */}
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="fixed inset-0 z-[55] pointer-events-none"
      />
    </CelebrationContext.Provider>
  );
}
