import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Keyframes that animate `box-shadow` or `border-color` repaint the element
 *  on the main thread every frame, for as long as they run. The flag halo
 *  runs forever on every flagged board card, the grid blink on every tile
 *  waiting for an operator. These keyframes may animate only what the
 *  compositor handles: opacity and transform. Their static colour lives on
 *  the element or on an overlay that owns the animation. */
const css = readFileSync(join(__dirname, '../../index.css'), 'utf8');

function keyframesBody(name: string): string {
  const m = css.match(new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!m) throw new Error(`@keyframes ${name} not found`);
  return m[1];
}

describe('card and tile animations stay on the compositor', () => {
  it.each(['flag-halo-ring', 'aito-rating-halo', 'code-breathe', 'grid-border-blink'])('%s animates only opacity/transform', (name) => {
    const body = keyframesBody(name);
    expect(body).not.toMatch(/box-shadow\s*:/);
    expect(body).not.toMatch(/border-color\s*:/);
    expect(body).toMatch(/opacity\s*:|transform\s*:/);
  });

  it('no rule runs the old box-shadow halo on the card itself', () => {
    expect(css).not.toMatch(/@keyframes flag-halo\s*\{/);
    expect(css).not.toMatch(/animation:\s*flag-halo\s/);
  });

  // The ring and the caret breath moved onto pseudo-elements; the reduced-motion
  // rules must follow them with enough specificity to win. `:has()` takes the
  // specificity of its argument, so `.aito-card-shell::after` (0,1,1) loses to
  // `.aito-card-shell:has(> .flag-urgent)::after` (0,2,1) whatever the order.
  it('reduced motion stops the ring and the caret breath with winning selectors', () => {
    const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g)].map((m) => m[1]);
    const joined = blocks.join('\n');
    expect(joined).toMatch(/\.aito-card-shell\.aito-card-shell::after\s*\{[^}]*animation:\s*none/);
    expect(joined).toMatch(/\.code-caret::after[^{]*\{[^}]*animation:\s*none/);
  });
});
