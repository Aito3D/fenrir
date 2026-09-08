import { useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays, X } from 'lucide-react';
import { useDueDateMutation } from '../../hooks/useDueDateMutation';
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
 *  A native date input is still the picker — nothing custom beats the OS one
 *  on a phone — but it is laid over the whole stat at `opacity-0` rather than
 *  shown, because what the browser draws (`mm/dd/yyyy`, its own calendar glyph,
 *  an unstyleable spin of segments) cannot be made to match the stat beside
 *  it. Tone comes from `dueDateLevel`, the same ramp the board card's
 *  `DueDateBadge` uses, so "late" is one colour wherever it is read. */
export function DueDateControl({ project, canUpdate = true }: { project: AitoProject; canUpdate?: boolean }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const mutation = useDueDateMutation(project);
  const current = project.due_date ?? null;

  const today = localDateKey(new Date());
  const level = dueDateLevel(current, today);
  const days = dueDateDays(current, today);
  /** Where the picker opens when nothing is promised yet: two WORKING days
   *  out, not today. A job accepted now is not finished today, and the
   *  browser's own default — today — is the one date the answer is never.
   *  Weekends are skipped in the count and can never be the result, so a
   *  Friday click proposes Tuesday.
   *
   *  It is the input's value, not the project's: the stat still reads "—" and
   *  "Set a date", nothing is written, and the suggestion only becomes a
   *  promise if the operator picks a day. */
  const suggestion = addWorkingDays(new Date(), 2);
  // `far` and `none` fall through to white rather than `dueDateCls`'s grey:
  // on a 260px card grey means "set, but not your problem today", while at
  // 1.15rem semibold beside the age stat it would read as disabled.
  const toneCls = days === null ? 'text-bambu-gray' : dueDateCls(level) || 'text-white';

  // "3 d late", never `time.daysAgo`'s "3d ago": a promise that has passed is
  // not an event that happened, and the two read nothing alike.
  // An em dash, not a translation key: the parity gate rejects a leaf whose
  // value matches English in every other locale, and a dash has no other
  // value to have. The "Set a date" line below carries the words.
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
   *  dropped. `min` below tells the browser's own picker the same, so the two
   *  agree about what is selectable. Clearing (null) always commits. */
  const commit = (next: string | null) => {
    if (next !== null && Number(next.slice(0, 4)) < 2000) return;
    if (next === current) return;
    mutation.mutate(next);
  };

  /** The input is invisible, so the click that lands on it would otherwise
   *  only focus it — the browser opens its picker from the calendar glyph we
   *  are covering. `showPicker` is absent in jsdom and pre-16 Safari, and
   *  throws if the call is ever reached outside a user gesture; neither case
   *  should cost the user the field, which stays keyboard-editable either
   *  way. */
  const openPicker = () => {
    const el = inputRef.current;
    if (typeof el?.showPicker !== 'function') return;
    try {
      el.showPicker();
    } catch {
      /* not a user gesture, or the browser refuses — the input still works */
    }
  };

  return (
    <div data-testid="due-date-control" data-due-level={level} className="group relative text-right flex-shrink-0">
      {/* The label IS the eyebrow — one string doing both jobs, so the stat
          reads as a peer of "CREATED" and the field still has an accessible
          name without a second, duplicate sr-only copy. */}
      <label htmlFor={id} className={`${eyebrowCls} block text-bambu-gray`}>
        {t('aito.dueDate')}
      </label>
      <span
        data-testid="due-date-value"
        className={`flex items-center justify-end gap-1.5 text-[1.15rem] leading-tight font-semibold tracking-[-0.01em] tabular-nums ${toneCls}`}
      >
        {/* Leading, not trailing: the row is `justify-end`, so a button before
            the glyph grows leftward and the stat's right edge stays flush with
            the eyebrow and the date below it whether the button is there or
            not. Revealed on hover, on keyboard focus anywhere in the stat, and
            unconditionally on a touch screen, which has no hover to give. */}
        {canUpdate && current !== null && (
          <button
            type="button"
            aria-label={t('aito.dueDateClear')}
            onClick={() => commit(null)}
            className={`relative z-10 rounded-full p-0.5 text-bambu-gray opacity-0 transition-opacity hover:text-white group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100 ${focusRingCls}`}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
        {/* strokeWidth 2.5 so the glyph's stems match the semibold digits
            beside it, same reason as the age stat's Clock. */}
        <CalendarDays className="w-[.95rem] h-[.95rem] flex-shrink-0" strokeWidth={2.5} aria-hidden="true" />
        {countdown}
      </span>
      {current !== null ? (
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
      ) : (
        canUpdate && (
          // Always visible, and green: with no date there is no corroboration
          // to show, and an em dash alone says nothing about being clickable.
          // This line is the affordance.
          <span data-testid="due-date-empty" className="block text-xs text-bambu-green">
            {t('aito.dueDateEmpty')}
          </span>
        )
      )}
      {canUpdate && (
        <input
          id={id}
          ref={inputRef}
          type="date"
          min="2000-01-01"
          value={current ?? suggestion}
          onChange={(e) => commit(e.target.value || null)}
          onClick={openPicker}
          // Covers the whole stat, so a click anywhere on it opens the picker.
          // The clear button opts out with `relative z-10` — a positioned
          // sibling paints over an absolute one that has no z-index of its own.
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      )}
    </div>
  );
}
