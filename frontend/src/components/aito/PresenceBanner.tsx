import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye } from 'lucide-react';

/** How long the closed banner stays mounted so its fold can play — matches
 *  the `duration-200` on the closed state below. `setTimeout`, not
 *  `transitionend`: that event never fires once reduced motion (or jsdom)
 *  drops the transition, and a banner that never unmounts would keep a dead
 *  band between the header and the body. */
const PRESENCE_EXIT_MS = 200;

/** The panel's "someone else has this open" bar.
 *
 *  It sits between the header and the body, so mounting it pushes the task
 *  column down under the operator's cursor — mid-tick, if they are unlucky.
 *  So it unfolds and folds instead of appearing: the same grid 1fr↔0fr idiom
 *  as TaskRow's body fold, entered from @starting-style (Tailwind's
 *  `starting:` variant) so a plain mount transitions from the closed track,
 *  and left on the exit curve with the unmount deferred past the fold.
 *
 *  Reduced motion keeps the fade and drops the height tween — the height is
 *  the half that moves the body.
 *
 *  `names` is the already-filtered list of OTHER viewers; the caller owns
 *  that filter (it needs the current user for it). The last non-empty list is
 *  kept for the fold so the bar still names someone on its way out. */
export function PresenceBanner({ names }: { names: string[] }) {
  const { t } = useTranslation();
  const open = names.length > 0;
  const label = names.join(', ');
  const lastLabelRef = useRef(label);
  if (open) lastLabelRef.current = label;

  // Stored-previous-render pattern, deliberately not an effect: the render
  // where `open` flips false must ALREADY be the closed-but-mounted one, or
  // the element unmounts for a frame and the fold has nothing to run on.
  const [prevOpen, setPrevOpen] = useState(open);
  const [lingering, setLingering] = useState(false);
  if (prevOpen !== open) {
    setPrevOpen(open);
    setLingering(!open);
  }
  useEffect(() => {
    if (!lingering) return;
    const id = window.setTimeout(() => setLingering(false), PRESENCE_EXIT_MS);
    return () => window.clearTimeout(id);
  }, [lingering]);

  if (!open && !lingering) return null;

  return (
    <div
      inert={!open}
      className={`flex-shrink-0 grid motion-reduce:transition-opacity ${
        open
          ? 'grid-rows-[1fr] opacity-100 starting:grid-rows-[0fr] starting:opacity-0 transition-[grid-template-rows,opacity] duration-[250ms] ease-[var(--ease-signature)]'
          : 'grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity] duration-200 ease-[var(--ease-exit)] pointer-events-none'
      }`}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          data-testid="aito-presence-banner"
          className="flex items-center gap-2 border-b border-amber-400/20 bg-amber-500/10 px-5 py-2 text-sm text-amber-300"
        >
          <Eye className="w-4 h-4 flex-none" aria-hidden="true" />
          {t('aito.viewingNow', { name: lastLabelRef.current })}
        </div>
      </div>
    </div>
  );
}
