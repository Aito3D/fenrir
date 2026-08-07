import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Flag, RotateCcw } from 'lucide-react';
import { HoldButton } from './HoldButton';
import { headerPillRadiusCls } from './panelTypography';
import { useFlagMutation } from '../../hooks/useFlagMutation';
import { type AitoFlag, type AitoProject } from '../../api/client';

/** Per-flag styling, spelled out in full rather than composed, because
 *  Tailwind cannot see a constructed class name and because the two tones are
 *  fixed semantics — amber for urgency, rose for a returned job — that must
 *  not shift when the user changes accent colour. Red is the destructive
 *  colour on this board and lives on the footer bar; rose never shares a strip
 *  with it. */
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
};

/** The container's own skin once a flag is live — this is the moment the
 *  control stops being a control and becomes a status pill, matched to the
 *  shipping pill beside it (`headerPillCls`). */
const CONTAINER_TONE: Record<AitoFlag, string> = {
  urgent: 'border-amber-400/30 bg-amber-400/[0.14]',
  sav: 'border-rose-400/30 bg-rose-400/[0.14]',
};

const ORDER: AitoFlag[] = ['urgent', 'sav'];

/** One object for both board flags, because they are mutually exclusive and a
 *  person picks between them rather than toggling each.
 *
 *  At rest and unflagged it is a ghost chip. On hover, focus or tap it opens
 *  into two hold-to-confirm segments; once a flag is set it collapses onto
 *  that segment alone and IS the status pill — same .4rem outline, 11px
 *  semibold type and 3.5 glyph as the shipping pill beside it. So the flag
 *  reads as a fact about the project in the row where the project's other
 *  facts already live, and the control that sets it is the same object.
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
  // The resting chip stays mounted while it holds focus, even though opening
  // collapses it. Unmounting it under its own focus would send focus to
  // <body>, and the blur handler would immediately close what the click just
  // opened.
  const [restFocused, setRestFocused] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
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
  };

  const restShown = !flag && (!open || restFocused);

  return (
    <div
      ref={rootRef}
      data-testid="flag-control"
      data-open={open}
      role="group"
      aria-label={t('aito.markFlag')}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
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

      {ORDER.map((kind) => {
        const on = flag === kind;
        const shown = open || on;
        const tone = TONE[kind];
        return (
          <span
            key={kind}
            data-testid={`flag-segment-${kind}`}
            // A hairline between the two only while both are open — a divider
            // beside nothing is just a stray line.
            className={`overflow-hidden transition-[max-width,opacity] duration-[260ms] ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none ${
              kind === 'sav' && open && shown ? 'border-l border-bambu-dark-tertiary' : ''
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
              label={on ? t(kind === 'urgent' ? 'aito.clearUrgent' : 'aito.clearSav') : t(kind === 'urgent' ? 'aito.markUrgent' : 'aito.markSav')}
              hint={on
                ? t(kind === 'urgent' ? 'aito.holdToClearUrgent' : 'aito.holdToClearSav')
                : t(kind === 'urgent' ? 'aito.holdToMarkUrgent' : 'aito.holdToMarkSav')}
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
              {kind === 'urgent' ? (
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {t(kind === 'urgent' ? 'aito.urgent' : 'aito.sav')}
            </HoldButton>
          </span>
        );
      })}
    </div>
  );
}
