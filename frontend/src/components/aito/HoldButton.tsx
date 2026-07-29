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
  children,
}: {
  onHold: () => void;
  durationMs: HoldDurationMs;
  label: string;
  hint: string;
  disabled?: boolean;
  className?: string;
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
        className={`relative inline-flex items-center gap-1.5 rounded-md transition-[color,background-color,opacity,border-color] duration-100 focus-visible:outline-none focus-visible:ring-2 disabled:opacity-40 disabled:cursor-not-allowed ${className}`}
      >
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
