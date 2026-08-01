import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

// Hold-to-confirm progress ring geometry: a small circle traced around the
// button's content, animated via stroke-dashoffset instead of
// requestAnimationFrame so the browser's own CSS transition timeline drives
// the fill.
const HOLD_RADIUS = 9;
const HOLD_CIRCUMFERENCE = 2 * Math.PI * HOLD_RADIUS;
// Every duration a caller may pass must have an entry here, and each one is
// also named out loud in its caller's locale hint string. Keying this (and
// `durationMs` below) on the literal union rather than `number` means a
// future caller passing an unlisted duration fails to compile instead of
// silently rendering no ring animation — Tailwind needs static class
// strings, so the duration cannot be interpolated from the prop.
type HoldDurationMs = 500 | 1000;
const RING_DURATION_CLS: Record<HoldDurationMs, string> = {
  500: 'transition-[stroke-dashoffset] duration-[500ms] ease-linear motion-reduce:duration-200',
  1000: 'transition-[stroke-dashoffset] duration-[1000ms] ease-linear motion-reduce:duration-200',
};
// Same timeline for the bar variant, on transform instead of the ring's
// stroke. Keyed on the same literal union and for the same reason: Tailwind
// needs static class strings, so the duration cannot be interpolated.
const BAR_DURATION_CLS: Record<HoldDurationMs, string> = {
  500: 'transition-transform duration-[500ms] ease-linear motion-reduce:duration-200',
  1000: 'transition-transform duration-[1000ms] ease-linear motion-reduce:duration-200',
};
// The perimeter variant animates the same stroke-dashoffset the ring does, so
// it shares the ring's transition property — kept as its own map anyway, since
// the two are free to diverge and a shared constant would hide that.
const PERIMETER_DURATION_CLS = RING_DURATION_CLS;

/** How the hold's progress is drawn.
 *
 *  `ring` traces a circle around icon-sized buttons — right when the button
 *  IS its icon. `bar` fills the button left to right like a loading bar, for
 *  wide labelled pills: the ring's `viewBox="0 0 24 24"` scales to fit the
 *  shorter axis, so on a 130×28 pill it lands as a small circle floating over
 *  the middle of the label rather than as progress.
 *
 *  `perimeter` traces the button's own outline, corners included, so the
 *  border itself becomes the progress track. Right where the button is small
 *  but not round — the board card's icon actions — and where a bar sweeping
 *  under a single glyph would read as a highlight rather than as progress. */
export type HoldProgress = 'ring' | 'bar' | 'perimeter';
// A press released before this threshold counts as a "tap" and surfaces the
// hold hint; anything longer (but still short of completing) is treated as
// an intentional-but-abandoned hold and cancels silently.
const HOLD_HINT_THRESHOLD_MS = 400;
const HOLD_HINT_VISIBLE_MS = 1600;

/** A button that requires a pointer/keyboard hold of `durationMs` before it
 *  fires `onHold`, tracing a small progress ring around its content and
 *  surfacing a "hold to confirm" hint popover on a too-short tap. Extracted
 *  from the original hold-to-delete button so the same timer/hint/ring
 *  machinery can back both delete and the quote status actions — see
 *  task-12-brief.md. The base below carries only what both callers
 *  genuinely share — positioning, the ring wrapper, focus ring, transition,
 *  disabled handling — never padding or border-width. Those two set the
 *  rendered box size, and each caller wants a different box (delete's is
 *  icon-sized to match its sibling edit button; the quote actions are
 *  roomier pills); baking either into the base and expecting a caller's
 *  `className` to override it doesn't work; Tailwind compiles
 *  same-specificity utilities in a fixed order regardless of source
 *  position, so whichever value lands later in the compiled stylesheet always
 *  wins, not whichever the caller supplies. So every caller's `className`
 *  supplies its own padding, border (width and colour), and any other box or
 *  colour styling in full. */
export function HoldButton({
  onHold,
  durationMs,
  label,
  hint,
  disabled = false,
  className = '',
  progress = 'ring',
  barClassName = 'bg-red-400/25',
  children,
}: {
  onHold: () => void;
  durationMs: HoldDurationMs;
  label: string;
  hint: string;
  disabled?: boolean;
  className?: string;
  /** See `HoldProgress`. Defaults to `ring` so every existing caller — the
   *  task-row delete, the quote status pills, the board and grid actions —
   *  is unchanged. */
  progress?: HoldProgress;
  /** The bar's fill, `progress="bar"` only. A complete literal class string,
   *  not an interpolated one — Tailwind cannot see a constructed class name.
   *  Defaults to the destructive red; Accept passes green, because a bar that
   *  fills red under "Accept quote" reads as the wrong outcome mid-gesture. */
  barClassName?: string;
  children: ReactNode;
}) {
  const [holding, setHolding] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressStartRef = useRef(0);

  const clearHoldTimer = () => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };

  const startHold = () => {
    if (disabled) return;
    if (holdTimerRef.current) return; // already holding (e.g. key repeat before guard)
    pressStartRef.current = Date.now();
    setHolding(true);
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      setHolding(false);
      onHold();
    }, durationMs);
  };

  const cancelHold = () => {
    if (!holdTimerRef.current && !holding) return;
    clearHoldTimer();
    setHolding(false);
    if (Date.now() - pressStartRef.current < HOLD_HINT_THRESHOLD_MS) {
      setShowHint(true);
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      hintTimerRef.current = setTimeout(() => setShowHint(false), HOLD_HINT_VISIBLE_MS);
    }
  };

  useEffect(
    () => () => {
      clearHoldTimer();
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    },
    [],
  );

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={label}
        title={hint}
        disabled={disabled}
        data-holding={holding || undefined}
        onPointerDown={(e) => {
          e.stopPropagation();
          startHold();
        }}
        onClick={(e) => {
          // The hold timer owns firing; this only stops the native click —
          // which pointer-event stopPropagation does not suppress — from
          // bubbling further.
          e.stopPropagation();
        }}
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
        className={`relative inline-flex items-center gap-1.5 rounded-md transition-[color,background-color,opacity,border-color] duration-100 focus-visible:outline-none focus-visible:ring-2 disabled:opacity-40 disabled:cursor-not-allowed ${
          // Clip the bar to the button's own radius; harmless for the ring,
          // which is inside the box anyway.
          progress === 'bar' ? 'overflow-hidden ' : ''
        }${className}`}
      >
        {progress === 'bar' ? (
          // A loading bar filling left to right, in the same red the button
          // takes while held. `currentColor` would work too, but the fill has
          // to stay legible UNDER the label, so it is a fixed low-alpha red
          // rather than whatever the text colour happens to be mid-transition.
          <span
            aria-hidden="true"
            data-testid="hold-progress-bar"
            className={`pointer-events-none absolute inset-0 origin-left ${barClassName} ${
              holding ? `scale-x-100 ${BAR_DURATION_CLS[durationMs]}` : 'scale-x-0 transition-none'
            }`}
          />
        ) : progress === 'perimeter' ? (
          // The outline itself as the track. `pathLength={1}` normalises the
          // perimeter to 1 regardless of the button's rendered size, so one
          // dasharray/dashoffset pair works at any width without measuring —
          // which matters because these buttons size to their icon and their
          // padding, not to anything this component knows.
          //
          // `overflow-visible`: the stroke is centred on the rect's edge, so
          // half of it falls outside the 100%x100% box and would be clipped.
          // rx matches the button's own `rounded-md` (.375rem = 5.4px) so the
          // trace follows the corners rather than cutting across them.
          <svg
            className="pointer-events-none absolute inset-0 w-full h-full overflow-visible"
            fill="none"
            aria-hidden="true"
            data-testid="hold-progress-perimeter"
          >
            <rect
              x="0"
              y="0"
              width="100%"
              height="100%"
              rx="5.4"
              stroke="currentColor"
              strokeWidth="1.5"
              pathLength={1}
              strokeDasharray={1}
              strokeDashoffset={holding ? 0 : 1}
              // Hidden outright at rest rather than relying on the dash
              // pattern to draw nothing. A fully-offset dash still renders a
              // sub-pixel stub where the path starts, which showed as a dot on
              // the button's top edge before it was ever pressed. The switch
              // is instant and the trace begins at zero length, so there is
              // nothing to flash on press.
              strokeOpacity={holding ? 1 : 0}
              className={holding ? PERIMETER_DURATION_CLS[durationMs] : 'transition-none'}
            />
          </svg>
        ) : (
          <svg className="absolute inset-0 -rotate-90 w-full h-full" viewBox="0 0 24 24" aria-hidden="true">
            <circle
              cx="12"
              cy="12"
              r={HOLD_RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray={HOLD_CIRCUMFERENCE}
              strokeDashoffset={holding ? 0 : HOLD_CIRCUMFERENCE}
              className={holding ? RING_DURATION_CLS[durationMs] : 'transition-none'}
            />
          </svg>
        )}
        {children}
      </button>
      {showHint && (
        <div className="absolute bottom-full right-0 mb-1 whitespace-nowrap rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-2 py-1 text-xs text-white shadow-lg animate-fade-in">
          {hint}
        </div>
      )}
    </div>
  );
}
