import { useState } from 'react';
import { useLocation, useOutlet } from 'react-router-dom';

/**
 * Renders the routed page, mounting the destination immediately on navigation.
 *
 * Browsers with the View Transitions API get their page change animated by the
 * router-level crossfade (NavLinks/navigate pass `viewTransition`; see
 * index.css ::view-transition rules) — so this wrapper adds NO entrance class
 * there, otherwise the page would animate twice. Browsers without the API fall
 * back to the 250ms .animate-page-in rise. Exactly one of the two ever applies.
 *
 * Reduced-motion: .animate-page-in is neutralized in index.css's reduce block,
 * and the ::view-transition rules are disabled under the same media query.
 */
export function AnimatedOutlet() {
  const outlet = useOutlet();
  const location = useLocation();
  // Evaluated at mount (not import) so tests can stub startViewTransition.
  const [supportsViewTransitions] = useState(
    () => typeof document.startViewTransition === 'function',
  );

  return (
    <div key={location.pathname} className={supportsViewTransitions ? undefined : 'animate-page-in'}>
      {outlet}
    </div>
  );
}
