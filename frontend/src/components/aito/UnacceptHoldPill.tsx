import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { useQuoteStatusMutation } from '../../hooks/useQuoteStatusMutation';
import { headerPillCls } from './panelTypography';
import { type AitoProject } from '../../api/client';

/** How long the mark must be held before the acceptance is revoked. 1s, not
 *  the quote actions' 500ms: those move a quote FORWARD along a path the next
 *  hold can correct, while this un-authorises work the whole board has
 *  already released — the gesture has to discourage, not merely prove
 *  intent, exactly like hold-to-delete. */
export const UNACCEPT_HOLD_MS = 1000;
/** How long the settle bounce runs after a completed hold, matching
 *  `unaccept-settle` in index.css. The revoke fires only when it ends. */
export const UNACCEPT_SETTLE_MS = 600;

// Same tap-vs-abandoned-hold split as HoldButton: a press released before
// this threshold counts as a tap and surfaces the hint; a longer one was an
// intentional-but-abandoned hold and cancels silently.
const HINT_THRESHOLD_MS = 400;
const HINT_VISIBLE_MS = 1600;

type Phase = 'idle' | 'holding' | 'settling';

/** The gesture and its choreography, unconnected: everything the mark does
 *  visually, with the commit abstracted to a callback so the FX bench can
 *  demo the animation against a fake board. Production use goes through
 *  {@link UnacceptHoldPill} below, which wires the real mutation.
 *
 *  Not a HoldButton caller, deliberately. HoldButton's contract is "progress
 *  indicator over an unchanged button" — a ring, bar or perimeter trace, a
 *  fixed 1.08 press scale, and `onHold` fired the instant the timer lands.
 *  This mark's whole feedback IS the button changing: it inflates subtly toward 1.1×
 *  while its green continuously turns red (the colour ramp is the progress
 *  indicator), and on completion it deflates through a bounce and only THEN
 *  commits. That last part is load-bearing, not decorative: the revoke's
 *  optimistic cache write flips `quote_status`, which unmounts this very
 *  component — committing at completion would cut the settle animation dead.
 *  So the commit waits for the settle timer, and the unmount cleanup below
 *  flushes it if the panel dies first, so a completed gesture is never lost.
 *
 *  The hold/hint timer machinery is intentionally the same shape as
 *  HoldButton's; only the presentation contract differs. */
export function UnacceptHoldMark({
  /** Fired once per completed gesture, after the settle bounce — or from the
   *  unmount cleanup if the component dies while settling, so a completed
   *  hold is never lost. */
  onCommit,
  disabled = false,
  holdMs = UNACCEPT_HOLD_MS,
  settleMs = UNACCEPT_SETTLE_MS,
}: {
  onCommit: () => void;
  disabled?: boolean;
  /** Gesture durations, overridable ONLY so the FX bench can run the
   *  choreography in slow motion for design review. Production (the panel's
   *  UnacceptHoldPill) always uses the defaults. Note the settle KEYFRAMES
   *  stay at their CSS-declared speed unless `settleMs` scales them via the
   *  bench's animation-duration override. */
  holdMs?: number;
  settleMs?: number;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('idle');
  const [showHint, setShowHint] = useState(false);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressStartRef = useRef(0);
  // The commit, reachable from the unmount cleanup without the effect
  // depending on the caller keeping `onCommit`'s identity stable.
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  const startHold = () => {
    if (phase !== 'idle' || disabled) return;
    pressStartRef.current = Date.now();
    setPhase('holding');
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      setPhase('settling');
      settleTimerRef.current = setTimeout(() => {
        settleTimerRef.current = null;
        setPhase('idle');
        commitRef.current();
      }, settleMs);
    }, holdMs);
  };

  const cancelHold = () => {
    if (!holdTimerRef.current) return;
    clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
    setPhase('idle');
    if (Date.now() - pressStartRef.current < HINT_THRESHOLD_MS) {
      setShowHint(true);
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      hintTimerRef.current = setTimeout(() => setShowHint(false), HINT_VISIBLE_MS);
    }
  };

  useEffect(
    () => () => {
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      if (settleTimerRef.current) {
        // The gesture already completed — the person held the full second and
        // watched the mark turn red. Only the settle cosmetics were pending,
        // so losing the panel must not lose the revoke.
        clearTimeout(settleTimerRef.current);
        commitRef.current();
      }
    },
    [],
  );

  const charged = phase !== 'idle';

  return (
    <span className="relative inline-flex flex-shrink-0">
      <button
        type="button"
        data-testid="panel-quote-status-pill"
        aria-label={t('aito.unacceptLabel')}
        title={t('aito.unacceptHint')}
        data-holding={phase === 'holding' || undefined}
        data-settling={phase === 'settling' || undefined}
        onPointerDown={(e) => {
          e.stopPropagation();
          startHold();
        }}
        onClick={(e) => e.stopPropagation()}
        onPointerUp={(e) => {
          e.stopPropagation();
          cancelHold();
        }}
        onPointerLeave={(e) => {
          e.stopPropagation();
          cancelHold();
        }}
        onPointerCancel={(e) => {
          e.stopPropagation();
          cancelHold();
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.stopPropagation();
          if (!e.repeat) {
            e.preventDefault();
            startHold();
          }
        }}
        onKeyUp={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.stopPropagation();
          cancelHold();
        }}
        style={{
          // Hand-written transitions rather than Tailwind utilities: the
          // sweep and the colour ramp must run LINEARLY over exactly the
          // hold duration (they ARE the progress indicator) while the
          // inflate eases, and mixing easings on one element needs the
          // longhand. `scale`, not `transform`: Tailwind v4's scale
          // utilities set the native `scale` property, which a transition
          // naming only `transform` silently never animates. The idle
          // branch is what springs an abandoned hold back in 150ms instead
          // of rewinding it over a full second.
          transition:
            phase === 'holding'
              ? `scale ${holdMs}ms cubic-bezier(0.4, 0, 0.6, 1), color ${holdMs}ms linear, border-color ${holdMs}ms linear, box-shadow ${holdMs}ms linear`
              : 'scale 150ms ease-out, color 150ms ease-out, border-color 150ms ease-out, box-shadow 300ms ease-out',
          // The settle keyframes' pace follows settleMs, so the bench's slow
          // motion slows the bounce too; at the default this equals the
          // class's own 0.6s.
          animationDuration: phase === 'settling' ? `${settleMs}ms` : undefined,
        }}
        className={`${headerPillCls} relative overflow-hidden cursor-pointer select-none touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-status-error/60 bg-bambu-green/[0.14] ${
          charged
            ? 'text-white border-status-error shadow-[0_0_16px_rgba(239,68,68,0.5)]'
            : 'text-bambu-green-light border-bambu-green/30 shadow-[0_0_0_rgba(239,68,68,0)]'
        } ${phase === 'holding' ? 'motion-safe:scale-[1.1]' : ''} ${
          phase === 'settling' ? 'animate-unaccept-settle' : ''
        }`}
      >
        {/* The progress bar: red sweeping left to right over the still-green
            pill, exactly one hold long. In the DOM at rest (collapsed) so
            the sweep is a transition, not a mount; kept full through the
            settle so the landed pill stays red. Same `scale` caveat as the
            button's own transition above. */}
        <span
          aria-hidden="true"
          data-testid="unaccept-progress-fill"
          className={`pointer-events-none absolute inset-0 origin-left bg-status-error/85 ${
            charged ? 'scale-x-100' : 'scale-x-0'
          }`}
          style={{
            transition:
              phase === 'holding'
                ? `scale ${holdMs}ms linear`
                : phase === 'settling'
                  ? 'none'
                  : 'scale 150ms ease-out',
          }}
        />
        {/* `relative` so the label paints ABOVE the absolutely-positioned
            fill — positioned boxes otherwise paint over in-flow inline
            content regardless of DOM order. */}
        <span className="relative inline-flex items-center gap-1.5">
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
          {t('aito.quoteStatus.accepted')}
        </span>
      </button>
      {showHint && (
        <span className="absolute z-20 top-full left-0 mt-1 whitespace-nowrap rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-2 py-1 text-xs font-normal normal-case tracking-normal text-white shadow-lg animate-fade-in">
          {t('aito.unacceptHint')}
        </span>
      )}
    </span>
  );
}

/** The panel header's "Accepted" mark, made revocable: hold it for
 *  {@link UNACCEPT_HOLD_MS} and the acceptance is removed — locally and in
 *  Zoho — for the two real cases the static pill couldn't serve: an Accept
 *  held by mistake, and a quote modified after acceptance that needs the
 *  client's go-ahead again. */
export function UnacceptHoldPill({
  project,
  /** Called once the revoke has been committed, after the settle bounce —
   *  the panel passes its own `onClose`, which is what makes the card's move
   *  to Waiting visible. */
  onDone,
}: {
  project: AitoProject;
  onDone: () => void;
}) {
  // The shared quote-status mutation, with the one toast override: this
  // transition's target IS 'sent', but announcing it as "Quote marked as
  // sent" would pass a revoked authorisation off as an ordinary send.
  const mutation = useQuoteStatusMutation(project, { sent: 'aito.quoteUnaccepted' });

  return (
    <UnacceptHoldMark
      disabled={mutation.isPending}
      onCommit={() => {
        mutation.mutate('sent');
        onDone();
      }}
    />
  );
}
