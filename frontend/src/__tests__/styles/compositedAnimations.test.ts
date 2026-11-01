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
});
