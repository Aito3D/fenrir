import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Flag, Pause, RotateCcw, type LucideIcon } from 'lucide-react';
import { HoldButton } from './HoldButton';
import { headerPillRadiusCls } from './panelTypography';
import { useFlagMutation } from '../../hooks/useFlagMutation';
import { type AitoFlag, type AitoProject } from '../../api/client';

/** Per-flag styling, spelled out in full rather than composed, because
 *  Tailwind cannot see a constructed class name and because the tones are
 *  fixed semantics — amber for urgency, rose for a returned job, teal for a
 *  paused job — that must not shift when the user changes accent colour. Red
 *  is the destructive colour on this board and lives on the footer bar; rose
 *  never shares a strip with it. */
const TONE: Record<AitoFlag, { on: string; off: string; bar: string; ring: string }> = {
  urgent: {
    on: 'text-amber-400',
    off: 'text-bambu-gray hover:text-amber-400',
    bar: 'bg-amber-400/25',
    ring: 'focus-visible:ring-amber-400/40',
  },
  sav: {
    on: 'text-rose-400',
    off: 'text-bambu-gray hover:text-rose-400',
    bar: 'bg-rose-400/25',
    ring: 'focus-visible:ring-rose-400/40',
  },
  pause: {
    on: 'text-teal-400',
    off: 'text-bambu-gray hover:text-teal-400',
    bar: 'bg-teal-400/25',
    ring: 'focus-visible:ring-teal-400/40',
  },
};

/** Copy and glyph per flag. Records rather than the chained ternaries this
 *  file carried at two flags: with three, each of those becomes a nested
 *  chain evaluated inside a JSX attribute, and every one is a place to put
 *  the wrong string against the wrong flag. A record keeps each string
 *  greppable and makes a future fourth flag a compile error rather than a
 *  silently missing label. */
const COPY: Record<AitoFlag, { mark: string; clear: string; holdMark: string; holdClear: string }> = {
  urgent: {
    mark: 'aito.markUrgent',
    clear: 'aito.clearUrgent',
    holdMark: 'aito.holdToMarkUrgent',
    holdClear: 'aito.holdToClearUrgent',
  },
  sav: {
    mark: 'aito.markSav',
    clear: 'aito.clearSav',
    holdMark: 'aito.holdToMarkSav',
    holdClear: 'aito.holdToClearSav',
  },
  pause: {
    mark: 'aito.markPause',
    clear: 'aito.clearPause',
    holdMark: 'aito.holdToMarkPause',
    holdClear: 'aito.holdToClearPause',
  },
};
const GLYPH: Record<AitoFlag, LucideIcon> = { urgent: AlertTriangle, sav: RotateCcw, pause: Pause };
const LABEL_KEY: Record<AitoFlag, string> = { urgent: 'aito.urgent', sav: 'aito.sav', pause: 'aito.pause' };

/** The container's own skin once a flag is live — this is the moment the
 *  control stops being a control and becomes a status pill, matched to the
 *  shipping pill beside it (`headerPillCls`). */
const CONTAINER_TONE: Record<AitoFlag, string> = {
  urgent: 'border-amber-400/30 bg-amber-400/[0.14]',
  sav: 'border-rose-400/30 bg-rose-400/[0.14]',
  pause: 'border-teal-400/30 bg-teal-400/[0.14]',
};

const ORDER: AitoFlag[] = ['urgent', 'sav', 'pause'];

/** One object for all board flags, because they are mutually exclusive and a
 *  person picks between them rather than toggling each.
 *
 *  At rest and unflagged it is a ghost chip. On hover, focus or tap it opens
 *  into hold-to-confirm segments, one per flag; once a flag is set it
 *  collapses onto that segment alone and IS the status pill — same .4rem
 *  outline, 11px semibold type and 3.5 glyph as the shipping pill beside it.
 *  So the flag reads as a fact about the project in the row where the
 *  project's other facts already live, and the control that sets it is the
 *  same object.
 *
 *  Holds are symmetric — the same 0.5s sets and clears. A flagged job is
 *  exactly the thing that must not be un-flagged by a stray click, and a
 *  gesture deliberate in one direction and casual in the other invites
 *  precisely that. OPENING is not one of those gestures: it reveals a choice
 *  and changes nothing, so the resting chip is a plain click.
 *
 *  Panel only, never the board card: flagging is a deliberate act that belongs
 *  where you have the project open in front of you. */
export function FlagControl({ project }: { project: AitoProject }) {
  const { t } = useTranslation();
  const mutation = useFlagMutation(project);
  const flag = project.flag;
  const [open, setOpen] = useState(false);
  // Kept visible whenever the resting chip itself holds focus, even after
  // opening collapses it for everyone else. The chip is never unmounted here
  // — it is CSS-collapsed to `max-w-0 opacity-0`, and a zero-width,
  // opacity-0 element keeps focus just fine — so without this a keyboard
  // user's focus ring would end up sitting on an invisible, zero-width
  // button.
  const [restFocused, setRestFocused] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Set immediately before `choose()`'s own `rootRef.current.focus()` and
  // cleared the moment that focus event is observed, so the root's `onFocus`
  // can tell "I just parked focus here after a commit" apart from a real
  // focus arriving on the root from outside (there is no other signal —
  // both look like a focus event whose target IS the root).
  const suppressNextRootFocusRef = useRef(false);
  // A one-shot bump on commit, so the collapse reads as "that landed" rather
  // than as the pill merely losing its hover. It lives on the CONTAINER
  // because each segment passes `pressEffect="none"` — HoldButton's own bounce
  // would be clipped by the container's overflow-hidden.
  const [bumping, setBumping] = useState(false);
  const bumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (bumpTimer.current) clearTimeout(bumpTimer.current);
  }, []);

  // Touch has neither hover nor pointerleave, so an outside press is the only
  // thing that can close the control there.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const choose = (next: AitoFlag) => {
    // Holding the live segment clears it; holding the other switches straight
    // across. One request either way — never clear-then-set.
    mutation.mutate(flag === next ? null : next);
    setOpen(false);
    setBumping(true);
    if (bumpTimer.current) clearTimeout(bumpTimer.current);
    bumpTimer.current = setTimeout(() => setBumping(false), 340);
    // The held segment is about to go `disabled` (via `mutation.isPending`,
    // then via `!shown` once the flag change lands), which blurs it and would
    // otherwise throw a keyboard user's focus back to <body>. Move focus to
    // the root instead — it is a valid target (`tabIndex={-1}` below) that
    // survives both disablements, so focus stays inside the control.
    suppressNextRootFocusRef.current = true;
    rootRef.current?.focus();
  };

  const restShown = !flag && (!open || restFocused);

  return (
    <div
      ref={rootRef}
      data-testid="flag-control"
      data-open={open}
      // Not `role="group"` + `aria-label` here — the resting chip's own text
      // is the same `aito.markFlag` string, so a screen reader would announce
      // "Mark, group" immediately followed by "Mark, button". Each segment is
      // self-describing ("Mark urgent" / "Mark returned") without a group
      // label.
      //
      // `tabIndex={-1}`: not a Tab stop (the segments and the resting chip
      // already are), but a valid `.focus()` target — see `choose()`, which
      // parks focus here after a commit so a disabled segment losing focus
      // does not throw a keyboard user back to <body>.
      tabIndex={-1}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={(e) => {
        // Focus landing on the root itself is normally a real "open me"
        // request (e.g. a screen reader or a test focusing the control
        // directly) and should open it — EXCEPT immediately after `choose()`
        // parks focus here on commit, where reopening would undo the close
        // that same commit just did. `suppressNextRootFocusRef` is the only
        // way to tell those two apart; both are a focus event whose target
        // is the root.
        if (e.target === e.currentTarget && suppressNextRootFocusRef.current) {
          suppressNextRootFocusRef.current = false;
          return;
        }
        setOpen(true);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
      // The border, radius and fill belong to the CONTAINER, not the segments,
      // so the thing that opens reads as one object widening rather than as
      // two buttons appearing. `overflow-hidden` is what clips the collapsed
      // segments to nothing.
      className={`inline-flex items-stretch overflow-hidden border ${headerPillRadiusCls} transition-[background-color,border-color] duration-150 ${
        flag && !open ? CONTAINER_TONE[flag] : 'border-bambu-dark-tertiary'
      } ${bumping ? 'motion-safe:animate-hold-bounce' : ''}`}
    >
      <span
        className={`overflow-hidden transition-[max-width,opacity] duration-[260ms] ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none ${
          restShown ? 'max-w-[9rem] opacity-100' : 'max-w-0 opacity-0'
        }`}
      >
        <button
          type="button"
          tabIndex={restShown ? 0 : -1}
          onClick={() => setOpen(true)}
          onFocus={() => setRestFocused(true)}
          onBlur={() => setRestFocused(false)}
          className="inline-flex items-center gap-1.5 whitespace-nowrap border-0 px-2 py-0.5 text-[11px] font-semibold text-bambu-gray transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"
        >
          <Flag className="h-3.5 w-3.5" aria-hidden="true" />
          {t('aito.markFlag')}
        </button>
      </span>

      {ORDER.map((kind, index) => {
        const on = flag === kind;
        const shown = open || on;
        const tone = TONE[kind];
        const Glyph = GLYPH[kind];
        return (
          <span
            key={kind}
            data-testid={`flag-segment-${kind}`}
            // Collapsed segments are `disabled` (below) and so already
            // untabbable, but a disabled button is still in the accessibility
            // tree — without this, browse mode reads three permanently-disabled
            // buttons whenever the control is closed and unflagged.
            aria-hidden={shown ? undefined : true}
            // A hairline before every segment after the first, only while
            // open — a divider beside nothing is just a stray line, and
            // index-based (not "is this the last kind") is what still draws
            // correctly as segments are added.
            className={`overflow-hidden transition-[max-width,opacity] duration-[260ms] ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none ${
              index > 0 && open ? 'border-l border-bambu-dark-tertiary' : ''
            } ${shown ? 'max-w-[9rem] opacity-100' : 'max-w-0 opacity-0'}`}
          >
            <HoldButton
              onHold={() => choose(kind)}
              durationMs={500}
              // `bar`, not `ring`: HoldButton's ring uses viewBox="0 0 24 24"
              // and would land as a small circle floating over the middle of a
              // wide label rather than as progress.
              progress="bar"
              barClassName={tone.bar}
              // The wrapper clips, so the outer scale and the completion
              // bounce would both be cut off — see HoldButton's pressEffect.
              pressEffect="none"
              disabled={mutation.isPending || !shown}
              ariaPressed={on}
              label={t(on ? COPY[kind].clear : COPY[kind].mark)}
              hint={t(on ? COPY[kind].holdClear : COPY[kind].holdMark)}
              // Square: the CONTAINER owns the corners. `rounded-md` compiles
              // after `rounded-none` in Tailwind's own order, so this has to go
              // through radiusClassName rather than className — see HoldButton.
              radiusClassName="rounded-none"
              // Downward: the panel root is `overflow-hidden` and this pill
              // sits on the header's first row, so the default upward hint
              // would be clipped away entirely rather than merely cramped.
              hintPlacement="bottom"
              // Padding, border width and colour in full, as every HoldButton
              // caller must: the base sets none of them, because
              // same-specificity Tailwind utilities resolve by compiled
              // stylesheet order rather than by call site. `border-0` here
              // because the container already drew the outline.
              className={`whitespace-nowrap border-0 px-2 py-0.5 text-[11px] font-semibold ${
                on ? tone.on : tone.off
              } ${tone.ring}`}
            >
              <Glyph className="h-3.5 w-3.5" aria-hidden="true" />
              {t(LABEL_KEY[kind])}
            </HoldButton>
          </span>
        );
      })}
    </div>
  );
}
