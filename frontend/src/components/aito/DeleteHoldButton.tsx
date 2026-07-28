import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';

// Hold-to-delete progress ring geometry: a small circle traced around the
// trash icon, animated via stroke-dashoffset instead of requestAnimationFrame
// so the browser's own CSS transition timeline drives the fill.
const HOLD_RADIUS = 9;
const HOLD_CIRCUMFERENCE = 2 * Math.PI * HOLD_RADIUS;
// Changing this means changing three other things in step, none of which the
// compiler couples to it: the ring's `duration-[1000ms]` class below (Tailwind
// needs a static string, so it cannot read this constant), and the
// `aito.holdToDelete` hint in all twelve locale files, which names the
// duration out loud.
const HOLD_DURATION_MS = 1000;
// A press released before this threshold counts as a "tap" and surfaces the
// hold hint; anything longer (but still short of completing) is treated as
// an intentional-but-abandoned hold and cancels silently.
const HOLD_HINT_THRESHOLD_MS = 400;
const HOLD_HINT_VISIBLE_MS = 1600;

// Trash2 button that requires a 1s pointer/keyboard hold to fire delete,
// replacing the old ConfirmModal flow. A short press instead shows a
// "hold to delete" hint popover. See task-14-brief.md for the full spec.
export function DeleteHoldButton({
  onDelete,
  label,
  hint,
}: {
  onDelete: () => void;
  label: string;
  hint: string;
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
    if (holdTimerRef.current) return; // already holding (e.g. key repeat before guard)
    pressStartRef.current = Date.now();
    setHolding(true);
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      setHolding(false);
      onDelete();
    }, HOLD_DURATION_MS);
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
        onPointerDown={(e) => {
          e.stopPropagation();
          startHold();
        }}
        onClick={(e) => {
          // The hold timer owns deletion; this only stops the native click —
          // which pointer-event stopPropagation does not suppress — from
          // bubbling further. The card root has no click handler any more
          // (the footer sits outside the body button), so there is nothing
          // for this to reach today; kept as a guard against future nesting.
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
        className={`relative p-1 -m-1 rounded-md text-bambu-gray hover:text-red-400 hover:bg-red-400/10 transition-[color,background-color,opacity] duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/40 ${
          holding ? 'opacity-100 text-red-400' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
        }`}
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
            className={
              holding
                ? 'transition-[stroke-dashoffset] duration-[1000ms] ease-linear motion-reduce:duration-200'
                : 'transition-none'
            }
          />
        </svg>
        <Trash2 className="relative w-3.5 h-3.5" />
      </button>
      {showHint && (
        <div className="absolute bottom-full right-0 mb-1 whitespace-nowrap rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-2 py-1 text-xs text-white shadow-lg animate-fade-in">
          {hint}
        </div>
      )}
    </div>
  );
}
