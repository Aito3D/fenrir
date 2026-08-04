import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

export interface UseDismissableDialogOptions {
  /** The exit-animation duration in ms (e.g. `.animate-drawer-out`). Omit for
   *  dialogs with no exit animation: `requestClose` then calls `onClose`
   *  synchronously and `closing` never becomes true. When given, `requestClose`
   *  instead flips `closing` to true immediately (so callers can swap in their
   *  exit classes that same render) and defers the actual `onClose` a beat
   *  past the animation — `setTimeout` rather than `animationend`, because
   *  that event never fires when reduced motion (or jsdom) replaces the
   *  animation, and a dialog that cannot close is worse than one that skips
   *  its exit. */
  animationMs?: number;
  /** Overrides what Escape does. Receives `requestClose` so it can still
   *  trigger the normal close path conditionally. Defaults to calling
   *  `requestClose()` unconditionally — the right behavior for a dialog where
   *  Escape only ever means "close". Sites where Escape sometimes means
   *  something else first (e.g. stepping back out of a sub-form) supply this
   *  instead of forcing that distinction into the shared hook. */
  onEscape?: (requestClose: () => void) => void;
}

export interface UseDismissableDialogResult {
  /** True once a close has been requested and the exit animation is playing.
   *  Always false when `animationMs` is omitted. */
  closing: boolean;
  /** Starts the close: with `animationMs`, flips `closing` and defers `onClose`
   *  past the animation; without it, calls `onClose` immediately. */
  requestClose: () => void;
  /** Attach to the dialog's outermost focusable element (`role="dialog"`,
   *  `tabIndex={-1}`). */
  dialogRef: RefObject<HTMLDivElement | null>;
}

/** The Escape/focus/close-animation triad every Aito drawer and panel needs:
 *  a window-level Escape listener, taking focus on mount, and (optionally)
 *  deferring the unmount past an exit animation. Shared by NewProjectDrawer,
 *  ImportQuoteDrawer and ProjectDetailPanel, which used to hand-roll this
 *  three times and had quietly drifted from each other.
 *
 *  Focus-on-mount is always the GUARDED variant —
 *  `contains(document.activeElement)` — never unconditional: something inside
 *  the dialog (a search input's own `autoFocus`, for instance) may already
 *  have claimed focus during the same commit, and stealing it back means the
 *  user's first keystroke goes nowhere. This is deliberately the same
 *  guard on every site even where nothing currently races it — the point is
 *  that a future field gaining `autoFocus` cannot silently reintroduce the
 *  bug on a site that had reverted to the unguarded version.
 *
 *  `onClose` rides in a ref rather than an effect dependency: it is a fresh
 *  closure on every parent render, and depending on it would re-register the
 *  window listener (and re-run the focus effect) on every render instead of
 *  once on mount. */
export function useDismissableDialog(
  onClose: () => void,
  { animationMs, onEscape }: UseDismissableDialogOptions = {},
): UseDismissableDialogResult {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const requestClose = () => {
    if (animationMs) setClosing(true);
    else onCloseRef.current();
  };
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  // Deferred unmount: the exit animation owns the close, this just makes sure
  // `onClose` still fires once it has had time to play.
  useEffect(() => {
    if (!closing || !animationMs) return;
    const id = window.setTimeout(() => onCloseRef.current(), animationMs);
    return () => window.clearTimeout(id);
  }, [closing, animationMs]);

  useEffect(() => {
    if (!dialogRef.current?.contains(document.activeElement)) dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (onEscapeRef.current) onEscapeRef.current(() => requestCloseRef.current());
      else requestCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // Mount-once: freshness comes from the refs above, not from re-running this.
  }, []);

  return { closing, requestClose, dialogRef };
}
