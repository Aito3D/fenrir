import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays, X } from 'lucide-react';
import { useDueDateMutation } from '../../hooks/useDueDateMutation';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { DatePicker } from './DatePicker';
import { eyebrowCls } from './panelTypography';
import { focusRingCls } from '../formStyles';
import { dueDateCls, dueDateDays, dueDateLevel } from '../../utils/aitoAging';
import { addWorkingDays, localDateKey, parseLocalDateKey } from '../../utils/date';
import type { AitoProject } from '../../api/client';

/** The promised day as the header's SECOND time stat, beside `PanelAgeStat`
 *  behind its own divider — same eyebrow, same 1.15rem value, same small date
 *  underneath. Money is how much, age is how long it has been open, this is
 *  how long is left, and those three are what a person opening the panel
 *  actually asks. Stacking it under the age stat instead made the whole
 *  masthead a row taller for one field, which is what this shape avoids.
 *
 *  The value is the COUNTDOWN, not the date: "in 13 d" answers the question a
 *  promise raises, while "Sep 20" makes the reader do the subtraction. The
 *  date is the corroboration on the line below, exactly as the age stat puts
 *  "42 days ago" over "Jul 27, 2026".
 *
 *  Unset, the stat is ONE action — a green outlined "Set a date" pill in the
 *  same recipe as the app's secondary buttons — rather than an em dash over a
 *  green helper line, which read as two half-states. The pill is 26 px and
 *  the set stat 35 px; both fit inside the band the Created stat already
 *  establishes, so switching between them never moves the header.
 *
 *  The picker is the app's own `DatePicker`, anchored under the stat, because
 *  the browser's popup is drawn outside the DOM and none of it — the today
 *  marker, the colours, the week start — can be styled from the page. On a
 *  coarse pointer the OS picker still opens from a transparent native input
 *  laid over the stat, since nothing custom beats it on a phone. Tone comes
 *  from `dueDateLevel`, the same ramp the board card's `DueDateBadge` uses,
 *  so "late" is one colour wherever it is read. */
export function DueDateControl({ project, canUpdate = true }: { project: AitoProject; canUpdate?: boolean }) {
  const { t, i18n } = useTranslation();
  const labelId = useId();
  const valueId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mutation = useDueDateMutation(project);
  const current = project.due_date ?? null;
  const coarse = useMediaQuery('(pointer: coarse)');
  const [open, setOpen] = useState(false);
  /** Where focus goes when the picker closes. A close from inside it (a
   *  pick, Clear, Escape) hands focus back to the trigger; an outside press
   *  leaves focus where the press put it (`false`).
   *
   *  `'now'` means the trigger that opened the picker is still the one on
   *  screen. `'swap'` means the pick is about to REPLACE it — the pill
   *  becomes the stat, or the stat becomes the pill — and focusing the old
   *  one would only be undone by its unmount, so the new one takes focus
   *  as it mounts instead. */
  const returnFocus = useRef<false | 'now' | 'swap'>(false);
  const setTriggerRef = useCallback((el: HTMLButtonElement | null) => {
    triggerRef.current = el;
    if (el && returnFocus.current === 'swap') {
      returnFocus.current = false;
      el.focus();
    }
  }, []);

  /** The landing motion plays when the value on screen is NEW — after a pick
   *  or a clear — and never on the panel's own first paint, which has its
   *  own entrance. `armed` flips after that paint. The class is decided once
   *  per value and remembered by it, because a later re-render (opening the
   *  picker, say) that added the class to the live element would replay the
   *  animation on nothing. A new value remounts the element by key, so it
   *  plays exactly once. */
  const armed = useRef(false);
  useEffect(() => {
    armed.current = true;
  }, []);
  const landing = useRef<{ value: string | null; cls: string } | null>(null);
  if (landing.current === null || landing.current.value !== current) {
    landing.current = { value: current, cls: armed.current ? 'animate-aito-due-land' : '' };
  }
  const landCls = landing.current.cls;

  const today = localDateKey(new Date());
  const level = dueDateLevel(current, today);
  const days = dueDateDays(current, today);
  /** Where the picker opens when nothing is promised yet: two WORKING days
   *  out, not today. A job accepted now is not finished today, and the
   *  browser's own default — today — is the one date the answer is never.
   *  Weekends are skipped in the count and can never be the result, so a
   *  Friday click proposes Tuesday.
   *
   *  It is a proposal, not the project's value: the pill still reads "Set a
   *  date", nothing is written, and the suggestion only becomes a promise if
   *  the operator picks it. */
  const suggestion = addWorkingDays(new Date(), 2);
  // `far` and `none` fall through to white rather than `dueDateCls`'s grey:
  // on a 260px card grey means "set, but not your problem today", while at
  // 1.15rem semibold beside the age stat it would read as disabled.
  const toneCls = days === null ? 'text-bambu-gray' : dueDateCls(level) || 'text-white';

  // "3 d late", never `time.daysAgo`'s "3d ago": a promise that has passed is
  // not an event that happened, and the two read nothing alike.
  const countdown =
    days === null
      ? '—'
      : days === 0
        ? t('time.today')
        : days > 0
          ? t('time.inDays', { count: days })
          : t('aito.dueLateDays', { count: -days });

  /** A native date input fires `change` for EVERY intermediate value a typed
   *  year passes through: typing "2026" over an otherwise complete date emits
   *  0002-09-12, 0020-09-12, 0202-09-12 and only then 2026-09-12. Committing
   *  those would be four PATCHes, four `project.due.set` story events and
   *  three renders of a card promised in antiquity, i.e. overdue.
   *
   *  A year below 2000 is therefore a keystroke, not a promise, and is
   *  dropped. `min` on the input tells the browser's own picker the same, so
   *  the two agree about what is selectable. Clearing (null) always commits. */
  const commit = (next: string | null) => {
    if (next !== null && Number(next.slice(0, 4)) < 2000) return;
    if (next === current) return;
    mutation.mutate(next);
  };

  const close = () => {
    if (returnFocus.current !== 'swap') returnFocus.current = 'now';
    setOpen(false);
  };
  const pick = (next: string | null) => {
    // Same emptiness on both sides means the same trigger stays; otherwise
    // the pick swaps it, and the swap decides where focus lands.
    if ((next === null) !== (current === null)) returnFocus.current = 'swap';
    commit(next);
  };
  useEffect(() => {
    if (open || returnFocus.current !== 'now') return;
    returnFocus.current = false;
    triggerRef.current?.focus();
  }, [open]);
  // Touch has neither hover nor pointerleave, so an outside press is the only
  // thing that can close the control there; on a desktop it is the expected
  // way to abandon a popover. The root holds trigger and picker both, so a
  // press on the trigger reaches its own toggle instead of closing here.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  /** Coarse pointers only. The native input is invisible, so the tap that
   *  lands on it would otherwise only focus it — the browser opens its picker
   *  from the calendar glyph we are covering. `showPicker` is absent in jsdom
   *  and pre-16 Safari, and throws if the call is ever reached outside a user
   *  gesture; neither case should cost the user the field, which stays
   *  keyboard-editable either way. */
  const openNativePicker = () => {
    const el = inputRef.current;
    if (typeof el?.showPicker !== 'function') return;
    try {
      el.showPicker();
    } catch {
      /* not a user gesture, or the browser refuses — the input still works */
    }
  };

  const interactive = canUpdate && !coarse;
  const stat = (
    <>
      <span
        key={current ?? ''}
        id={valueId}
        data-testid="due-date-value"
        className={`flex items-center justify-end gap-1.5 text-[1.15rem] leading-tight font-semibold tracking-[-0.01em] tabular-nums ${landCls} ${toneCls} ${
          interactive ? 'decoration-[color-mix(in_srgb,currentColor_35%,transparent)] underline-offset-[3px] group-hover/stat:underline' : ''
        }`}
      >
        {/* strokeWidth 2.5 so the glyph's stems match the semibold digits
            beside it, same reason as the age stat's Clock. */}
        <CalendarDays className="w-[.95rem] h-[.95rem] flex-shrink-0" strokeWidth={2.5} aria-hidden="true" />
        {countdown}
      </span>
      {current !== null && (
        // Dropped first when the header runs out of room, same as the age
        // stat's date: the countdown above is the point, the day is the
        // corroboration.
        <span data-testid="due-date-date" className="hidden lg:block text-xs text-bambu-gray tabular-nums">
          {parseLocalDateKey(current).toLocaleDateString(i18n.language, {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          })}
        </span>
      )}
    </>
  );

  return (
    <div
      ref={rootRef}
      data-testid="due-date-control"
      data-due-level={level}
      className="group relative text-right flex-shrink-0"
    >
      {/* The eyebrow names the trigger too (aria-labelledby), so the stat
          reads as a peer of "CREATED" and the control still has an accessible
          name without a second, duplicate sr-only copy. */}
      <span id={labelId} className={`${eyebrowCls} block text-bambu-gray`}>
        {t('aito.dueDate')}
      </span>
      {current === null && canUpdate ? (
        <button
          ref={setTriggerRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={`mt-1 inline-flex items-center gap-1.5 rounded-[.4rem] border border-bambu-green/40 bg-bambu-green/10 px-2.5 py-[5px] text-xs font-semibold leading-none text-bambu-green transition-colors hover:border-bambu-green/60 hover:bg-bambu-green/20 ${landCls} ${focusRingCls}`}
        >
          <CalendarDays className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden="true" />
          {t('aito.dueDateEmpty')}
        </button>
      ) : (
        <div className="flex items-start justify-end gap-1.5">
          {/* Coarse pointers have no popover to clear from, and no hover to
              reveal a control on, so the X is simply there. It sits BEFORE
              the stat so it grows leftward and the stat's right edge stays
              flush with the eyebrow. `relative z-10` lifts it over the
              transparent native input below. */}
          {canUpdate && coarse && current !== null && (
            <button
              type="button"
              aria-label={t('aito.dueDateClear')}
              onClick={() => commit(null)}
              className={`relative z-10 mt-0.5 rounded-full p-0.5 text-bambu-gray hover:text-white ${focusRingCls}`}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
          {interactive ? (
            <button
              ref={setTriggerRef}
              type="button"
              aria-haspopup="dialog"
              aria-expanded={open}
              aria-labelledby={`${labelId} ${valueId}`}
              onClick={() => setOpen((o) => !o)}
              className={`group/stat block rounded-md text-right ${focusRingCls}`}
            >
              {stat}
            </button>
          ) : (
            <div className="text-right">{stat}</div>
          )}
        </div>
      )}
      {canUpdate && coarse && (
        <input
          ref={inputRef}
          type="date"
          min="2000-01-01"
          aria-labelledby={labelId}
          value={current ?? suggestion}
          onChange={(e) => commit(e.target.value || null)}
          onClick={openNativePicker}
          // Covers the whole stat, so a tap anywhere on it opens the OS picker.
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      )}
      {interactive && open && (
        <DatePicker
          value={current}
          today={today}
          suggested={suggestion}
          label={t('aito.dueDate')}
          onChange={pick}
          onClose={close}
        />
      )}
    </div>
  );
}
