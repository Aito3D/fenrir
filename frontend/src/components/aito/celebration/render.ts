import { alphaOf, progress, type Particle } from './particles';

/** Canvas drawing for the celebration engine.
 *
 *  Two passes, because the two families of particle need opposite blend modes
 *  and switching `globalCompositeOperation` per particle is the one thing that
 *  actually costs on this canvas:
 *
 *  - Light (sparks, glows, rings) draws with `lighter`. Additive is not a
 *    stylistic choice here: overlapping sparks on a dark UI have to sum toward
 *    white the way real light does, or a dense burst reads as a flat sticker.
 *  - Ribbons draw normally. Confetti is paper, not light — additive confetti
 *    goes translucent and glowing, which is precisely the cheap look this is
 *    trying to avoid.
 */

/** Soft round sprites, one per colour, built once and reused.
 *
 *  The alternative — a `createRadialGradient` per particle per frame — is a
 *  gradient object and a fresh shader for every one of up to a thousand
 *  particles at 60Hz. Same picture, an order of magnitude more work. */
const SPRITE_SIZE = 64;
const sprites = new Map<string, HTMLCanvasElement>();

function glowSprite(color: string): HTMLCanvasElement | null {
  const cached = sprites.get(color);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = SPRITE_SIZE;
  canvas.height = SPRITE_SIZE;
  const ctx = canvas.getContext('2d');
  // jsdom has no 2d context. Nothing here is load-bearing for behaviour, so
  // the whole renderer degrades to a no-op rather than throwing in tests.
  if (!ctx) return null;

  const r = SPRITE_SIZE / 2;
  const gradient = ctx.createRadialGradient(r, r, 0, r, r, r);
  // Drawn white first and tinted below, so `color` may be any CSS colour the
  // theme happens to use — hex, rgb(), oklch() — without this file having to
  // parse it into components.
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.22, 'rgba(255,255,255,0.65)');
  gradient.addColorStop(0.55, 'rgba(255,255,255,0.16)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);

  // `source-in` keeps the gradient's alpha and replaces its colour: the tint
  // lands on the falloff instead of on a hard-edged square.
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);

  sprites.set(color, canvas);
  return canvas;
}

/** Dropped when the theme accent changes, so a recoloured burst is not drawn
 *  with the previous theme's sprites. */
export function clearSpriteCache(): void {
  sprites.clear();
}

function drawGlow(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, radius: number): void {
  const sprite = glowSprite(color);
  if (!sprite) return;
  ctx.drawImage(sprite, x - radius, y - radius, radius * 2, radius * 2);
}

function drawSpark(ctx: CanvasRenderingContext2D, p: Particle, alpha: number): void {
  // The streak is the last `trail` seconds of travel, taken from the CURRENT
  // velocity — so it stretches while the spark is fast and collapses to a dot
  // as drag kills it, with no separate length animation to keep in sync.
  const tailX = p.x - p.vx * p.trail;
  const tailY = p.y - p.vy * p.trail;
  const length = Math.hypot(p.x - tailX, p.y - tailY);

  if (p.trail > 0 && length > 1) {
    ctx.globalAlpha = alpha * 0.55;
    ctx.strokeStyle = p.color;
    ctx.lineWidth = p.size;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(tailX, tailY);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }

  // Head: a wide soft glow plus a small hot core. Two draws rather than one
  // is what gives a spark a centre — a single sprite at any size reads as fog.
  ctx.globalAlpha = alpha * 0.85;
  drawGlow(ctx, p.color, p.x, p.y, p.size * 3.2);
  ctx.globalAlpha = alpha;
  drawGlow(ctx, '#ffffff', p.x, p.y, p.size * 1.1);
}

function drawRing(ctx: CanvasRenderingContext2D, p: Particle, alpha: number): void {
  const radius = p.size + p.grow * p.age;
  // The stroke thins as the ring grows: a shockwave that keeps its weight
  // reads as a drawn circle, not as an expanding front of light.
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = p.color;
  ctx.lineWidth = Math.max(0.5, 3 * (1 - progress(p)));
  ctx.beginPath();
  ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
  ctx.stroke();
}

function drawRibbon(ctx: CanvasRenderingContext2D, p: Particle, alpha: number): void {
  // The horizontal squash is the tumble: a flat strip turning edge-on to the
  // viewer is exactly a cosine on its width. Cheaper and steadier than any
  // 3D transform, and it never disappears completely (the 0.12 floor) because
  // a strip that vanishes for two frames reads as a dropped frame.
  const squash = Math.max(0.12, Math.abs(Math.cos(p.age * p.flutter + p.seed)));
  ctx.globalAlpha = alpha;
  ctx.fillStyle = p.color;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.rot);
  ctx.scale(squash, 1);
  ctx.fillRect(-p.size, -p.size * 0.42, p.size * 2, p.size * 0.84);
  ctx.restore();
}

export function draw(ctx: CanvasRenderingContext2D, particles: Particle[], clock: number): void {
  ctx.globalCompositeOperation = 'lighter';
  for (const p of particles) {
    if (p.shape === 'ribbon') continue;
    const alpha = alphaOf(p, clock);
    if (alpha <= 0.01) continue;
    if (p.shape === 'ring') drawRing(ctx, p, alpha);
    else if (p.shape === 'glow') {
      ctx.globalAlpha = alpha;
      drawGlow(ctx, p.color, p.x, p.y, p.size * 3);
    } else drawSpark(ctx, p, alpha);
  }

  ctx.globalCompositeOperation = 'source-over';
  for (const p of particles) {
    if (p.shape !== 'ribbon') continue;
    const alpha = alphaOf(p, clock);
    if (alpha <= 0.01) continue;
    drawRibbon(ctx, p, alpha);
  }

  ctx.globalAlpha = 1;
}
