/**
 * Drive a 1-second countdown from delayMs down to 0, invoking onTick with the
 * remaining whole seconds (including the initial value and a final 0).
 * Returns a cancel function that stops the countdown without a final tick.
 *
 * Shared by the grid stream and WebRTC reconnect overlays.
 */
export function startCountdown(delayMs: number, onTick: (remaining: number) => void): () => void {
  let remaining = Math.ceil(delayMs / 1000);
  onTick(remaining);
  const interval = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(interval);
      onTick(0);
    } else {
      onTick(remaining);
    }
  }, 1000);
  return () => clearInterval(interval);
}
