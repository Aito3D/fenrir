/** Colours for a celebration, read from the live theme.
 *
 *  The app ships six accents (green, teal, blue, orange, purple, red — see
 *  `--accent` in index.css) and the user picks one. A firework hard-coded to
 *  Bambu green would be the only thing on the screen that ignores that choice,
 *  so the palette is read from the document at burst time rather than baked in.
 *
 *  Read once per burst, not per frame: `getComputedStyle` forces style
 *  resolution, and doing that inside the rAF loop would make a purely
 *  decorative effect the most expensive thing on the page. */

export interface Palette {
  /** The theme accent. */
  accent: string;
  /** Its lighter sibling, for variation inside one burst. */
  accentLight: string;
  /** Near-white with a warm cast — the hot core of a real spark, and what
   *  keeps an accent-only burst from reading as a flat coloured smudge. */
  hot: string;
  /** Firework gold. Present in every variant at low count: one warm tone
   *  against the accent is what makes the colour look chosen rather than
   *  computed. */
  gold: string;
  /** Confetti's full spread — the accent plus festive companions. */
  confetti: string[];
}

const FALLBACK_ACCENT = '#00ae42';
const FALLBACK_ACCENT_LIGHT = '#00c64d';

function readVar(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = styles.getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

export function readPalette(root: Element | null = typeof document !== 'undefined' ? document.documentElement : null): Palette {
  let accent = FALLBACK_ACCENT;
  let accentLight = FALLBACK_ACCENT_LIGHT;

  if (root && typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    const styles = window.getComputedStyle(root);
    accent = readVar(styles, '--accent', FALLBACK_ACCENT);
    accentLight = readVar(styles, '--accent-light', accent);
  }

  return {
    accent,
    accentLight,
    hot: '#fff6e0',
    gold: '#ffc247',
    confetti: [accent, accentLight, '#fff6e0', '#ffc247', '#ff5d8f', '#4cc9f0'],
  };
}

/** Pick from a list with the injected rng — every variant's one source of
 *  colour, so a deterministic rng gives a deterministic burst. */
export function pick<T>(items: readonly T[], rng: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))];
}
