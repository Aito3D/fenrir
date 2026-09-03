import { useEffect, useState } from 'react';

/**
 * Subscribes to a CSS media query and returns whether it currently matches.
 *
 * Every breakpoint-boolean hook in this codebase (`useIsMobile`,
 * `useIsWideLayout`, `useIsSidebarCompact`, the calculator's local
 * `useBelowXl`, and `Dashboard`'s inline `stackBelow` effect) independently
 * reimplemented this same `useState` + `useEffect` + `matchMedia` shape.
 * This is the single extraction point — callers own their exact query
 * string and initial-value strategy, so each call site's original behaviour
 * (including differences in initial state and boundary math) is preserved
 * exactly rather than normalised.
 *
 * Includes the pre-2019 Safari `addListener`/`removeListener` fallback
 * (`MediaQueryList.addEventListener` wasn't supported until Safari 14):
 * every caller gains it, which only adds browser support and cannot change
 * behaviour in any environment that already worked.
 *
 * @param query - A CSS media query string (e.g. `'(max-width: 767px)'`), or
 *   `null`/`undefined` to disable the subscription entirely — used by
 *   `Dashboard`, whose `stackBelow` prop is optional.
 * @param getInitialValue - Optional lazy initializer for the value used on
 *   first render, before the effect has run. Defaults to `false`. Some call
 *   sites synchronously derive this from `window.innerWidth` to avoid an
 *   initial-paint flash; others deliberately start at `false` and let the
 *   effect correct it on mount.
 */
export function useMediaQuery(query: string | null | undefined, getInitialValue?: () => boolean): boolean {
  const [matches, setMatches] = useState(() => (getInitialValue ? getInitialValue() : false));

  useEffect(() => {
    if (!query || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }

    const mediaQuery = window.matchMedia(query);

    const handleChange = (event: MediaQueryListEvent | MediaQueryList) => {
      setMatches(event.matches);
    };

    // Set the initial value from the live query — this both establishes the
    // real value for call sites that start at a fixed `false`, and corrects
    // any pre-mount guess made from `window.innerWidth`.
    handleChange(mediaQuery);

    const onChange = (event: MediaQueryListEvent) => handleChange(event);

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', onChange);
    } else {
      // Pre-2019 Safari.
      mediaQuery.addListener(onChange);
    }

    return () => {
      if (mediaQuery.removeEventListener) {
        mediaQuery.removeEventListener('change', onChange);
      } else {
        mediaQuery.removeListener(onChange);
      }
    };
  }, [query]);

  return matches;
}
