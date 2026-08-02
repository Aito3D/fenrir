import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/** The perimeter trace's corner radius, matching the button's `rounded-md`
 *  (.375rem at the app's 14.4px root). Clamped per-button to half the shorter
 *  side, so a button smaller than 2×radius still describes a valid path. */
const PERIMETER_RADIUS = 5.4;

/** A rounded-rect outline that STARTS AT TOP CENTRE and runs clockwise back to
 *  it, rather than at the top-left corner where an SVG `<rect>`'s own path
 *  begins.
 *
 *  Hand-built because `<rect>` gives no control over where its path starts,
 *  and the dash pattern cannot be phase-shifted to fake one: a single dash
 *  cannot wrap past the path end, so offsetting the start just clips the tail.
 *  That is also why this needs the button's measured size — SVG path data
 *  takes no percentages, so the geometry cannot be expressed resolution-free
 *  the way the `<rect>` version was. */
function perimeterPath(w: number, h: number): string {
  const r = Math.min(PERIMETER_RADIUS, w / 2, h / 2);
  const mid = w / 2;
  return [
    `M ${mid} 0`,
    `H ${w - r}`,
    `A ${r} ${r} 0 0 1 ${w} ${r}`,
    `V ${h - r}`,
    `A ${r} ${r} 0 0 1 ${w - r} ${h}`,
    `H ${r}`,
    `A ${r} ${r} 0 0 1 0 ${h - r}`,
    `V ${r}`,
    `A ${r} ${r} 0 0 1 ${r} 0`,
    `H ${mid}`,
  ].join(' ');
}

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
  const [completed, setCompleted] = useState(false);
  const completeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showHint, setShowHint] = useState(false);
  // Measured, not assumed: these buttons size to their icon and their padding,
  // and the perimeter path needs real pixels (see `perimeterPath`). Observed
  // rather than read once, so a font or zoom change re-fits the trace.
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
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
      setCompleted(true);
      if (completeTimerRef.current) clearTimeout(completeTimerRef.current);
      completeTimerRef.current = setTimeout(() => setCompleted(false), 700);
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
      if (completeTimerRef.current) clearTimeout(completeTimerRef.current);
    },
    [],
  );

  useLayoutEffect(() => {
    if (progress !== 'perimeter') return;
    const el = buttonRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.offsetWidth, h: el.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [progress]);

  return (
    <div
      className={`relative motion-safe:transition-transform motion-safe:ease-linear ${
        holding ? 'scale-[1.08] motion-reduce:scale-100' : ''
      } ${completed ? 'animate-hold-bounce' : ''}`}
      style={{ transitionDuration: holding ? `${durationMs}ms` : '150ms' }}
    >
      <button
        ref={buttonRef}
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
            style={holding || completed ? { filter: 'drop-shadow(0 0 3px currentColor)' } : undefined}
            className={`pointer-events-none absolute inset-0 origin-left ${barClassName} ${
              holding || completed ? 'scale-x-100' : 'scale-x-0'
            } ${
              holding
                ? BAR_DURATION_CLS[durationMs]
                : completed
                  ? 'opacity-0 transition-opacity duration-500 ease-out'
                  : 'transition-none'
            }`}
          />
        ) : progress === 'perimeter' && box ? (
          // The outline itself as the track, starting at top centre and
          // running clockwise — see `perimeterPath` for why this is a hand
          // built path rather than a `<rect>`.
          //
          // `pathLength={1}` still normalises the length, so the dash pair is
          // size-independent even though the path data is not.
          //
          // `overflow-visible`: the stroke is centred on the path, so half of
          // it falls outside the box and would otherwise be clipped.
          <svg
            className="pointer-events-none absolute inset-0 w-full h-full overflow-visible"
            viewBox={`0 0 ${box.w} ${box.h}`}
            fill="none"
            aria-hidden="true"
            data-testid="hold-progress-perimeter"
          >
            <path
              d={perimeterPath(box.w, box.h)}
              stroke="currentColor"
              strokeWidth="1.5"
              pathLength={1}
              strokeDasharray={1}
              strokeDashoffset={holding || completed ? 0 : 1}
              // Hidden outright at rest rather than relying on the dash
              // pattern to draw nothing. A fully-offset dash still renders a
              // sub-pixel stub where the path starts, which showed as a dot on
              // the button's top edge before it was ever pressed. The switch
              // is instant and the trace begins at zero length, so there is
              // nothing to flash on press.
              strokeOpacity={holding ? 1 : 0}
              style={holding || completed ? { filter: 'drop-shadow(0 0 3px currentColor)' } : undefined}
              className={
                holding
                  ? PERIMETER_DURATION_CLS[durationMs]
                  : completed
                    ? 'transition-[stroke-opacity] duration-500 ease-out'
                    : 'transition-none'
              }
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
              strokeDashoffset={holding || completed ? 0 : HOLD_CIRCUMFERENCE}
              strokeOpacity={holding ? 1 : completed ? 0 : 1}
              style={holding || completed ? { filter: 'drop-shadow(0 0 3px currentColor)' } : undefined}
              className={
                holding
                  ? RING_DURATION_CLS[durationMs]
                  : completed
                    ? 'transition-[stroke-opacity] duration-500 ease-out'
                    : 'transition-none'
              }
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
