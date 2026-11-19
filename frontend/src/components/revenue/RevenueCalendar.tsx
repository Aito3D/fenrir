import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { HBars, Legend, Panel, Split } from '../aito/stats/primitives';
import { focusRingCls } from '../formStyles';
import { Skeleton } from '../Skeleton';
import { REVENUE_HISTORY_START } from './lib/dates';
import { formatFcp } from './lib/format';
import { calendarLayout } from './lib/insights';
import type { CalendarDay, DailyResponse, TaxMode } from './lib/types';
import { useRevenueResource } from './useRevenueResource';

const GREEN = '#00ae42';
const ZERO_CLS = 'bg-bambu-dark-tertiary';
const CREDIT_CLS = 'bg-status-error';
const UNLOADED_CLS = 'border border-dashed border-bambu-gray';
const LEGEND_STEPS = [0.25, 0.5, 0.75, 1];
// Monday-first, matching calendarLayout's rows.
const WEEKDAY_DATES = Array.from({ length: 7 }, (_, i) => Date.UTC(2024, 0, 1 + i));
const STEP_CLS = `rounded-md bg-bambu-dark px-2 py-px text-bambu-gray-light hover:text-white disabled:opacity-40 disabled:hover:text-bambu-gray-light ${focusRingCls}`;
// A leap year starting on a Sunday spans 54 ISO-week columns; a fixed count keeps the cell size independent of the data.
const WEEK_COLS = 54;
const EMPTY_WEEK: (CalendarDay | null)[] = Array(7).fill(null);
const KEY_STEP: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, ArrowRight: 7, ArrowLeft: -7 };

/** Square-root scale: one big day must not flatten every other cell to the faintest step. */
const alphaFor = (v: number, max: number) => Math.round((0.15 + 0.85 * Math.sqrt(v / max)) * 100) / 100;

/** The last 12 months (loki's window) or one calendar year of daily sales as a heatmap (weeks across, weekdays down), and the mean per weekday over its fetched days. */
export function RevenueCalendar({ filterParams, taxMode, version, today }: { filterParams: string; taxMode: TaxMode; version: unknown; today: string }) {
  const { t, i18n } = useTranslation();
  const lastYear = Number(today.slice(0, 4));
  const firstYear = Number(REVENUE_HISTORY_START.slice(0, 4));
  // null = the server's rolling window (the last 364 days to today).
  const [year, setYear] = useState<number | null>(null);
  const query = year === null ? filterParams.slice(1) : `from=${year}-01-01&to=${year}-12-31${filterParams}`;
  const res = useRevenueResource<DailyResponse>(`/api/v1/revenue/daily${query ? `?${query}` : ''}`, version);
  const { error } = res;
  // Data from the previous window is never shown under the new label.
  const data = res.loading || error ? null : res.data;
  const layout = useMemo(() => (data ? calendarLayout(data.days) : null), [data]);
  const prevRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const [hover, setHover] = useState<CalendarDay | null>(null);
  const [focusDay, setFocusDay] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const lang = i18n.language;
  const longDate = new Intl.DateTimeFormat(lang, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const shortDate = new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const monthFmt = new Intl.DateTimeFormat(lang, { month: 'short', timeZone: 'UTC' });
  const weekdayLong = new Intl.DateTimeFormat(lang, { weekday: 'long', timeZone: 'UTC' });
  const weekdayNarrow = new Intl.DateTimeFormat(lang, { weekday: 'narrow', timeZone: 'UTC' });
  const utc = (day: string) => new Date(`${day}T00:00:00Z`);
  const pick = (d: { ht: number; ttc: number }) => (taxMode === 'ttc' ? d.ttc : d.ht);
  const tax = t(taxMode === 'ttc' ? 'revenue.ttc' : 'revenue.ht');
  const textOf = (d: CalendarDay) =>
    `${longDate.format(utc(d.day))} · ${d.fetched ? formatFcp(pick(d)) : t('revenue.calendar.notLoaded')}`;

  const days = data?.days ?? [];
  const index = new Map(days.map((d, i) => [d.day, i]));
  const active = focusDay !== null && index.has(focusDay) ? focusDay : (days[days.length - 1]?.day ?? null);
  const move = (e: KeyboardEvent, from: number) => {
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? days.length - 1 : KEY_STEP[e.key] !== undefined ? from + KEY_STEP[e.key] : null;
    if (next === null) return;
    e.preventDefault();
    const target = days[next];
    if (!target) return;
    setFocusDay(target.day);
    gridRef.current?.querySelector<HTMLElement>(`[data-day="${target.day}"]`)?.focus();
  };

  const title = t('revenue.calendar.title');
  const step = (to: number | null, atEnd: boolean, other: HTMLButtonElement | null, e: { currentTarget: HTMLButtonElement }) => {
    // The clicked button is about to be disabled: keep focus on the stepper rather than letting it fall to the body.
    if (atEnd && document.activeElement === e.currentTarget) other?.focus();
    setYear(to);
  };
  const stepper = (
    <span className="inline-flex items-center gap-2 text-xs text-bambu-gray-light">
      <button
        ref={prevRef}
        type="button"
        className={STEP_CLS}
        aria-label={t('revenue.calendar.prevYear')}
        disabled={year !== null && year <= firstYear}
        onClick={(e) => {
          const to = year === null ? lastYear : year - 1;
          step(to, to <= firstYear, nextRef.current, e);
        }}
      >
        ‹
      </button>
      <span className="tabular-nums">{year ?? t('revenue.calendar.rolling')}</span>
      <button
        ref={nextRef}
        type="button"
        className={STEP_CLS}
        aria-label={t('revenue.calendar.nextYear')}
        disabled={year === null}
        onClick={(e) => {
          const to = year === null || year >= lastYear ? null : year + 1;
          step(to, to === null, prevRef.current, e);
        }}
      >
        ›
      </button>
    </span>
  );

  let calendar;
  let means;
  if (error) {
    calendar = <p role="alert" className="text-sm text-status-error">{error}</p>;
    means = null;
  } else if (!data || !layout) {
    calendar = <div aria-busy="true"><Skeleton className="h-[140px] w-full" /></div>;
    means = <div aria-busy="true"><Skeleton className="h-[220px] w-full" /></div>;
  } else {
    const max = pick(layout.max);
    const avg = layout.weekdayMean.map(pick);
    const avgMax = Math.max(1, ...avg);
    const weeks = [...layout.weeks, ...Array<(CalendarDay | null)[]>(Math.max(0, WEEK_COLS - layout.weeks.length)).fill(EMPTY_WEEK)];
    const cols = `1.5rem repeat(${weeks.length}, minmax(9px, 1fr))`;
    // A month's name over the week holding its 1st (the first week's own month when the range starts mid-month).
    const monthOf = (w: (CalendarDay | null)[], i: number) => {
      const d = w.find((x) => x?.day.endsWith('-01')) ?? (i === 0 ? w.find((x) => x !== null) : undefined);
      return d ? monthFmt.format(utc(d.day)) : '';
    };
    const cellCls = (d: CalendarDay) => {
      if (!d.fetched) return UNLOADED_CLS;
      const v = pick(d);
      return v < 0 ? CREDIT_CLS : v === 0 || max <= 0 ? ZERO_CLS : '';
    };
    calendar = (
      <>
        <div className="overflow-x-auto rounded-lg bg-bambu-dark p-3">
          <div aria-hidden="true" className="grid gap-[3px] text-[10px] text-bambu-gray" style={{ gridTemplateColumns: cols }}>
            <span />
            {weeks.map((w, i) => (
              <span key={i} className="whitespace-nowrap">{monthOf(w, i)}</span>
            ))}
          </div>
          <div ref={gridRef} role="grid" aria-label={t('revenue.calendar.gridLabel')} className="mt-1 grid gap-[3px]">
            {WEEKDAY_DATES.map((wd, r) => (
              <div key={r} role="row" className="grid gap-[3px]" style={{ gridTemplateColumns: cols }}>
                <span role="rowheader" className="text-[10px] leading-none text-bambu-gray">
                  <span aria-hidden="true">{r % 2 === 0 ? weekdayNarrow.format(wd) : ''}</span>
                  <span className="sr-only">{weekdayLong.format(wd)}</span>
                </span>
                {weeks.map((w, wi) => {
                  const d = w[r];
                  if (!d) return <span key={wi} aria-hidden="true" />;
                  const v = pick(d);
                  const i = index.get(d.day)!;
                  return (
                    <span
                      key={d.day}
                      role="gridcell"
                      data-day={d.day}
                      tabIndex={d.day === active ? 0 : -1}
                      aria-label={textOf(d)}
                      className={`block aspect-square rounded-[3px] hover:ring-1 hover:ring-white/70 ${cellCls(d)} ${focusRingCls}`}
                      style={d.fetched && v > 0 && max > 0 ? { backgroundColor: `rgba(0, 174, 66, ${alphaFor(v, max)})` } : undefined}
                      onPointerEnter={() => setHover(d)}
                      onPointerLeave={() => setHover(null)}
                      onFocus={() => {
                        setHover(d);
                        setFocusDay(d.day);
                      }}
                      onBlur={() => setHover(null)}
                      onKeyDown={(e) => move(e, i)}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <ul aria-label={t('revenue.chart.legend')} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-bambu-gray-light">
            <li className="inline-flex items-center gap-1">
              <span>{t('revenue.calendar.less')}</span>
              <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-[3px] ${ZERO_CLS}`} />
              {LEGEND_STEPS.map((s) => (
                <span key={s} aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ backgroundColor: `rgba(0, 174, 66, ${alphaFor(s * s, 1)})` }} />
              ))}
              <span>{t('revenue.calendar.more')}</span>
            </li>
            <Legend cls={CREDIT_CLS}>{t('revenue.calendar.credit')}</Legend>
            <li className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-[3px] ${UNLOADED_CLS}`} />
              {t('revenue.calendar.notLoaded')}
            </li>
          </ul>
          <p data-testid="calendar-readout" className="min-h-[1.25em] text-xs tabular-nums text-white first-letter:uppercase">
            {hover ? textOf(hover) : ''}
          </p>
        </div>
      </>
    );
    means = (
      <HBars
        testId="weekday-means"
        labelWidth="w-24"
        rows={avg.map((m, i) => ({
          key: String(i),
          label: <span className="capitalize">{weekdayLong.format(WEEKDAY_DATES[i])}</span>,
          scale: m / avgMax,
          segments: [{ weight: 1, color: GREEN }],
          value: formatFcp(m),
        }))}
      />
    );
  }

  return (
    <Split>
      <Panel
        title={
          <p className="text-xs uppercase tracking-wide text-bambu-gray">
            {title}
            {data && (
              <span className="ml-2 normal-case tracking-normal">
                {`${shortDate.format(utc(data.from))} → ${shortDate.format(utc(data.to))} · ${tax}`}
              </span>
            )}
          </p>
        }
        action={stepper}
      >
        {calendar}
      </Panel>
      <Panel title={t('revenue.calendar.weekdayTitle')}>{means}</Panel>
    </Split>
  );
}
