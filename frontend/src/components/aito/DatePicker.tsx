import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { focusRingCls } from '../formStyles';
import { addWorkingDays, localDateKey, parseLocalDateKey, weekStartFor } from '../../utils/date';

function addDays(from: Date, count: number): Date {
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() + count);
}

function monthStart(key: string): Date {
  const d = parseLocalDateKey(key);
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** The same calendar day `delta` months away, clamped to the month's length
 *  so Jan 31 → Feb 28 rather than Date's own Mar 3. */
function shiftMonth(key: string, delta: number): string {
  const d = parseLocalDateKey(key);
  const first = new Date(d.getFullYear(), d.getMonth() + delta, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return localDateKey(new Date(first.getFullYear(), first.getMonth(), Math.min(d.getDate(), last)));
}

export interface DatePickerProps {
  /** The committed date, or null. */
  value: string | null;
  /** Today's `localDateKey`; a prop so tests can pin the calendar. */
  today?: string;
  /** Where focus lands when nothing is selected yet — the workshop's
   *  proposed promise. Marked, never selected: it only becomes the value if
   *  it is picked. */
  suggested?: string | null;
  /** The dialog's accessible name. */
  label: string;
  onChange: (next: string | null) => void;
  onClose: () => void;
}

const CELL_KEYS: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

/** An in-page calendar for a promise, anchored to the stat that opens it.
 *
 *  Built for what this picker actually does — a workshop promising a pickup
 *  day, almost always one or two weeks out — rather than as a generic
 *  calendar. Past days recede to grey and future days stay white, so the eye
 *  lands where a promise can go. Today is a dot beneath the number instead
 *  of a highlight box, so it never competes with the selection, which is the
 *  single filled cell. The footer's chips are how the shop promises in
 *  practice: one click, no hunting for the 20th.
 *
 *  Why not the browser's own popup: it is drawn outside the DOM, so nothing
 *  in it — its today marker, its colours, its week start — can be styled or
 *  even moved from the page. This owns all of that. On a coarse pointer the
 *  caller keeps the OS picker instead; nothing here beats it on a phone.
 *
 *  Positioning is the caller's `relative` root: this hangs off its right
 *  edge and opens downward, so it never covers the header it belongs to.
 *  Dismissal on an outside press is the caller's too, so the trigger and
 *  the popover share one "inside" and a click on the trigger toggles rather
 *  than closes-then-reopens. */
export function DatePicker({ value, today, suggested = null, label, onChange, onClose }: DatePickerProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const todayKey = today ?? localDateKey(new Date());
  const home = value ?? suggested ?? todayKey;

  const [focusKey, setFocusKey] = useState(home);
  const [view, setView] = useState(() => monthStart(home));
  /** Which way the last page turn went, or null until the first one. The
   *  grid is keyed by month, so a turn remounts it, and this picks the side
   *  it slides in from. Null on open: the popover's pop-in is the entrance,
   *  and a page sliding under it would be two motions for one click. */
  const [pageDir, setPageDir] = useState<'next' | 'prev' | null>(null);
  // Roving tabindex: exactly one cell is tabbable, and after a keyboard move
  // (or on open) it must also BE focused. Set before a move and consumed by
  // the effect below, so a mouse hover re-render never yanks focus.
  const focusPending = useRef(true);
  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusPending.current) return;
    focusPending.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-key="${focusKey}"]`)?.focus();
  }, [focusKey, view]);

  const weekStart = useMemo(() => weekStartFor(lang), [lang]);
  const fmt = useMemo(
    () => ({
      title: new Intl.DateTimeFormat(lang, { month: 'long', year: 'numeric' }),
      day: new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', year: 'numeric' }),
      weekday: new Intl.DateTimeFormat(lang, { weekday: 'narrow' }),
    }),
    [lang],
  );

  // Six rows of seven, starting on the week that holds the 1st, so the grid
  // never changes height between months and the footer never jumps.
  const cells = useMemo(() => {
    const lead = (view.getDay() - weekStart + 7) % 7;
    const start = addDays(view, -lead);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [view, weekStart]);
  const todayDate = parseLocalDateKey(todayKey);

  const moveFocus = (next: string) => {
    focusPending.current = true;
    setFocusKey(next);
    const nextView = monthStart(next);
    if (nextView.getTime() !== view.getTime()) {
      setPageDir(nextView > view ? 'next' : 'prev');
      setView(nextView);
    }
  };
  const moveMonth = (delta: number) => moveFocus(shiftMonth(focusKey, delta));
  const goHome = () => moveFocus(home);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = CELL_KEYS[event.key];
    if (delta !== undefined) {
      event.preventDefault();
      moveFocus(localDateKey(addDays(parseLocalDateKey(focusKey), delta)));
    } else if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault();
      moveMonth(event.key === 'PageUp' ? -1 : 1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const d = parseLocalDateKey(focusKey);
      const offset = (d.getDay() - weekStart + 7) % 7;
      moveFocus(localDateKey(addDays(d, event.key === 'Home' ? -offset : 6 - offset)));
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  const pick = (next: string | null) => {
    onChange(next);
    onClose();
  };
  // The tooltip names the day a chip lands on: "+2 days" from a Friday is
  // Tuesday, which the label alone would not say.
  const chip = (key: string, text: string) => (
    <button
      type="button"
      title={fmt.day.format(parseLocalDateKey(key))}
      onClick={() => pick(key)}
      className={`rounded-md bg-bambu-green/[.08] px-2 py-1 text-xs font-medium leading-tight text-bambu-green transition-colors hover:bg-bambu-green/[.16] ${focusRingCls}`}
    >
      {text}
    </button>
  );
  const pageCls = pageDir === null ? '' : pageDir === 'next' ? 'animate-aito-page-next' : 'animate-aito-page-prev';
  const navBtnCls = `inline-flex h-[26px] w-[26px] items-center justify-center rounded-md text-bambu-gray-light transition-colors hover:bg-bambu-dark-tertiary hover:text-white ${focusRingCls}`;

  return (
    <div
      role="dialog"
      aria-label={label}
      data-testid="date-picker"
      onKeyDown={onKeyDown}
      // A deeper shadow than the panel's cards, so it reads as floating over
      // them rather than as one more of them.
      className="absolute right-0 top-full z-40 mt-2 w-[272px] origin-top-right rounded-[.75rem] border border-bambu-dark-tertiary bg-bambu-dark-secondary p-[12px] text-left shadow-[0_12px_32px_-8px_rgba(0,0,0,.6),0_2px_6px_rgba(0,0,0,.35)] animate-aito-pop-in"
    >
      <div className="flex items-center justify-between px-0.5 pb-2">
        <button
          type="button"
          onClick={goHome}
          title={t('aito.datePickerBackToSelected')}
          className={`-ml-1.5 rounded-md px-1.5 py-0.5 text-[13.5px] font-semibold text-white transition-colors hover:bg-bambu-dark-tertiary ${focusRingCls}`}
        >
          {/* Keyed with the grid, so the title turns the page with it. */}
          <span key={view.getTime()} className={`inline-block ${pageCls}`}>
            {fmt.title.format(view)}
          </span>
        </button>
        <div className="flex gap-0.5">
          <button type="button" aria-label={t('aito.datePickerPrev')} onClick={() => moveMonth(-1)} className={navBtnCls}>
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button type="button" aria-label={t('aito.datePickerNext')} onClick={() => moveMonth(1)} className={navBtnCls}>
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-[repeat(7,32px)] justify-between" aria-hidden="true">
        {cells.slice(0, 7).map((d) => (
          <span key={d.getDay()} className="h-[18px] text-center text-[11px] leading-[18px] text-bambu-gray">
            {fmt.weekday.format(d)}
          </span>
        ))}
      </div>

      <div key={view.getTime()} ref={gridRef} role="grid" className={`mt-0.5 ${pageCls}`}>
        {Array.from({ length: 6 }, (_, row) => (
          <div key={row} role="row" className="grid grid-cols-[repeat(7,32px)] justify-between pb-0.5">
            {cells.slice(row * 7, row * 7 + 7).map((d) => {
              const key = localDateKey(d);
              const selected = key === value;
              const isToday = key === todayKey;
              const isSuggested = value === null && key === suggested;
              const past = d < todayDate;
              const other = d.getMonth() !== view.getMonth();
              const tone = selected
                ? 'bg-bambu-green font-semibold text-white hover:bg-bambu-green-light'
                : past
                  ? 'text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white'
                  : other
                    ? 'text-bambu-gray-dark hover:bg-bambu-dark-tertiary hover:text-white'
                    : 'text-white hover:bg-bambu-dark-tertiary';
              // The today dot is centred by translating half its own width,
              // not by a hand-tuned negative margin, so it stays centred
              // whatever the cell or the dot measures.
              const dot = isToday
                ? `after:absolute after:bottom-1 after:left-1/2 after:h-1 after:w-1 after:-translate-x-1/2 after:rounded-full after:content-[''] ${selected ? 'after:bg-white/90' : 'after:bg-bambu-green'}`
                : '';
              // The suggestion is an outline, not a fill: a fill would read as
              // already chosen, and it is only proposed.
              const hint = isSuggested ? 'ring-1 ring-inset ring-bambu-green/60' : '';
              return (
                <button
                  key={key}
                  type="button"
                  role="gridcell"
                  data-key={key}
                  aria-selected={selected}
                  aria-current={isToday ? 'date' : undefined}
                  aria-label={isSuggested ? `${fmt.day.format(d)} (${t('aito.datePickerSuggested')})` : fmt.day.format(d)}
                  tabIndex={key === focusKey ? 0 : -1}
                  onClick={() => pick(key)}
                  className={`relative inline-flex h-[32px] w-[32px] items-center justify-center rounded-[7px] text-[13px] tabular-nums transition-[color,background-color,scale] duration-150 active:scale-[.92] active:duration-75 motion-reduce:active:scale-100 focus-visible:z-[1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/55 ${tone} ${dot} ${hint}`}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="mt-2 flex items-center justify-between border-t border-bambu-dark-tertiary pt-2.5">
        {value !== null ? (
          <button
            type="button"
            onClick={() => pick(null)}
            className={`rounded-md px-1.5 py-1 text-xs text-bambu-gray transition-colors hover:text-white ${focusRingCls}`}
          >
            {t('common.clear')}
          </button>
        ) : (
          // Keeps the chips on the right when there is nothing to clear.
          <span aria-hidden="true" />
        )}
        <div className="flex gap-1">
          {/* Working days, so a Friday proposes Tuesday: the same rule as the
              caller's suggestion, which this chip therefore coincides with.
              No Today chip — a job accepted now is never finished today, and
              today is one click away under its dot in the grid. */}
          {chip(addWorkingDays(todayDate, 2), t('aito.datePickerPlusTwoDays'))}
          {chip(localDateKey(addDays(todayDate, 7)), t('aito.datePickerPlusOneWeek'))}
          {chip(localDateKey(addDays(todayDate, 14)), t('aito.datePickerPlusTwoWeeks'))}
        </div>
      </div>
    </div>
  );
}
