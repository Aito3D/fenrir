import { useLocation, useOutlet } from 'react-router-dom';

/**
 * Renders the routed page, mounting the destination immediately on navigation
 * and playing only the entrance animation (.animate-page-in). There is no
 * exit phase: the outgoing page is simply unmounted the instant the new one
 * takes its place, so navigation never waits on a timer before the
 * destination's DOM exists.
 *
 * Reduced-motion users get the same instant mount; `.animate-page-in` is
 * neutralized under prefers-reduced-motion in index.css, so no separate JS
 * branch is needed here.
 */
export function AnimatedOutlet() {
  const outlet = useOutlet();
  const location = useLocation();

  return (
    <div key={location.pathname} className="animate-page-in">
      {outlet}
    </div>
  );
}
