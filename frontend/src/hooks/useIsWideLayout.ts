import { useMediaQuery } from './useMediaQuery';

/**
 * Tailwind's `lg`. Kept in sync with the `lg:` classes it is paired with —
 * components using this hook usually also switch layout via `lg:` utilities,
 * and the two disagreeing produces a half-applied layout.
 */
const WIDE_LAYOUT_BREAKPOINT = 1024;

/**
 * True when there is room for a side-by-side layout.
 *
 * Prefer plain `lg:` classes where CSS alone can do the job. This exists for
 * the cases where the *behaviour* differs rather than only the styling — a
 * disclosure that collapses on narrow screens but is permanently open when it
 * has its own column, for instance, which CSS cannot express on its own.
 */
export function useIsWideLayout(): boolean {
  return useMediaQuery(`(min-width: ${WIDE_LAYOUT_BREAKPOINT}px)`, () =>
    typeof window !== 'undefined' ? window.innerWidth >= WIDE_LAYOUT_BREAKPOINT : false
  );
}
