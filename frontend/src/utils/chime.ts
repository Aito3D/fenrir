/**
 * Two-note chime (E6 then A6) from the Web Audio API: no asset to ship.
 *
 * Browsers only let audio start after the person has interacted with the
 * page, and WebKit (Safari, every iPad browser) goes further: a context
 * created outside a user gesture stays `suspended` and plays nothing. So the
 * app keeps ONE context, created and resumed inside the first pointerdown or
 * keydown (`unlockChime`, installed by the bell), and every chime reuses it.
 * Where `navigator.userActivation` exists we skip before trying; any other
 * failure is swallowed: the ring and the badge still say something arrived.
 */

let shared: AudioContext | null = null;
let removeUnlock: (() => void) | null = null;
let removeKeepAwake: (() => void) | null = null;

function contextClass(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

/** The shared context, created on first use. */
function context(): AudioContext | null {
  if (shared) return shared;
  const Ctx = contextClass();
  if (!Ctx) return null;
  shared = new Ctx();
  return shared;
}

function wake(ctx: AudioContext): void {
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
}

/** After the first unlock: a light, persistent gesture listener that only
 *  resumes the shared context when the system suspended it again (an iPad
 *  going to sleep). WebKit ignores resume() outside a gesture, so the chime's
 *  own resume cannot bring it back; the next tap or key does. */
function installKeepAwake(): void {
  if (removeKeepAwake || typeof window === 'undefined') return;
  const onGesture = () => {
    if (shared && shared.state === 'suspended') shared.resume().catch(() => {});
  };
  window.addEventListener('pointerdown', onGesture, true);
  window.addEventListener('keydown', onGesture, true);
  removeKeepAwake = () => {
    window.removeEventListener('pointerdown', onGesture, true);
    window.removeEventListener('keydown', onGesture, true);
    removeKeepAwake = null;
  };
}

/**
 * Create (or resume) the shared context on the first pointerdown/keydown —
 * inside the gesture, which is what WebKit requires. One-time: the listener
 * removes itself after it fires. Returns a remover for an unmount before any
 * gesture; installing twice reuses the pending listener.
 */
export function unlockChime(): () => void {
  if (typeof window === 'undefined') return () => {};
  if (removeUnlock) return removeUnlock;
  const onGesture = () => {
    remove();
    try {
      const ctx = context();
      if (ctx) {
        wake(ctx);
        installKeepAwake();
      }
    } catch {
      // No audio: the ring and the badge still happen.
    }
  };
  const remove = () => {
    window.removeEventListener('pointerdown', onGesture, true);
    window.removeEventListener('keydown', onGesture, true);
    if (removeUnlock === remove) removeUnlock = null;
  };
  window.addEventListener('pointerdown', onGesture, true);
  window.addEventListener('keydown', onGesture, true);
  removeUnlock = remove;
  return remove;
}

export function chime(): void {
  if (typeof navigator !== 'undefined' && navigator.userActivation?.hasBeenActive === false) return;
  try {
    const ctx = context();
    if (!ctx) return;
    wake(ctx);
    const play = (freq: number, at: number, dur: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + dur + 0.05);
    };
    play(1318.5, 0, 0.35); // E6
    play(1760, 0.18, 0.55); // A6
  } catch {
    // No audio: the ring and the badge still happen.
  }
}

/** Test seam: forget the shared context and any pending unlock listener. */
export function __resetChimeForTests(): void {
  removeUnlock?.();
  removeUnlock = null;
  removeKeepAwake?.();
  shared = null;
}
