import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useOutlet } from 'react-router-dom';

const EXIT_MS = 150; // must match .animate-page-out duration in index.css

type Displayed = { node: ReactNode; pathname: string };

/**
 * Renders the routed page with a two-phase transition on navigation: the
 * outgoing page plays .animate-page-out, then the incoming page plays
 * .animate-page-in — the old page leaves before the new one enters.
 *
 * We snapshot the outlet element (rather than switching on `<Routes location>`)
 * so the app's route table stays centralised in App.tsx: during the exit we keep
 * rendering the previously-snapshotted node while the router has already moved on.
 *
 * The swap is driven by a timeout (mirroring ToastContext's leaving-set), not
 * `onAnimationEnd`: child pages fire their own bubbling animationend events, and
 * under reduced motion the exit animation is neutralised so no event would fire.
 */
export function AnimatedOutlet() {
  const outlet = useOutlet();
  const location = useLocation();

  // Latest outlet, read at swap time so the effect doesn't depend on it.
  const outletRef = useRef<ReactNode>(outlet);
  outletRef.current = outlet;

  const [displayed, setDisplayed] = useState<Displayed>({ node: outlet, pathname: location.pathname });
  const [stage, setStage] = useState<'in' | 'out'>('in');

  useEffect(() => {
    if (location.pathname === displayed.pathname) {
      // Back on the page we're already showing (e.g. navigated away and back
      // within the exit window). Cancel any in-progress exit so .animate-page-out
      // with its forwards-fill doesn't leave the page stuck faded out.
      setStage('in');
      return;
    }

    // Reduced motion: swap instantly, no exit phase (and no timer to wait on).
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDisplayed({ node: outletRef.current, pathname: location.pathname });
      setStage('in');
      return;
    }

    setStage('out');
    const handle = window.setTimeout(() => {
      setDisplayed({ node: outletRef.current, pathname: location.pathname });
      setStage('in');
    }, EXIT_MS);
    return () => window.clearTimeout(handle);
  }, [location.pathname, displayed.pathname]);

  return (
    <div key={displayed.pathname} className={stage === 'out' ? 'animate-page-out' : 'animate-page-in'}>
      {displayed.node}
    </div>
  );
}
