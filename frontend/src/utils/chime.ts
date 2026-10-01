/**
 * Two-note chime (E6 then A6) from the Web Audio API: no asset to ship.
 *
 * Browsers only let audio start after the person has interacted with the
 * page. Where `navigator.userActivation` exists we skip before trying; where
 * it does not, the attempt may be rejected, and that is swallowed: the ring
 * and the badge still say something arrived.
 */
export function chime(): void {
  if (typeof navigator !== 'undefined' && navigator.userActivation?.hasBeenActive === false) return;
  try {
    const Ctx =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
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
    setTimeout(() => {
      ctx.close().catch(() => {});
    }, 1200);
  } catch {
    // No audio: the ring and the badge still happen.
  }
}
