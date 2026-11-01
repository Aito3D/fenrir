/**
 * Pure helpers for the Maintenance → Hours tab: series building, interpolation,
 * monthly buckets, sheet-paste parsing, import planning and family colours.
 * Dates are ISO `YYYY-MM-DD` strings handled as UTC day numbers, so the
 * browser's timezone never shifts a reading by a day.
 */
import type { HourImportBody, HourMachine, HourReading } from '../api/client';

export interface HourPoint {
  date: string;
  hours: number;
}

export interface MachineSeries {
  manual: HourPoint[];
  auto: HourPoint[];
}

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');

export function dayNumber(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

const byDate = (a: HourPoint, b: HourPoint) => a.date.localeCompare(b.date);

/**
 * Manual readings, plus auto readings newer than the last manual one (older ones predate calibration)
 * and not lower than it: lifetime hours never decrease, so a lower auto value is a counter that has
 * not been calibrated yet (calibration happens when a reading dated today is saved).
 */
export function machineSeries(readings: HourReading[], machineId: number): MachineSeries {
  const mine = readings.filter((r) => r.machine_id === machineId);
  const manual = mine
    .filter((r) => r.source === 'manual')
    .map((r) => ({ date: r.reading_date, hours: r.hours }))
    .sort(byDate);
  const lastManual = manual.length ? manual[manual.length - 1] : null;
  const auto = mine
    .filter((r) => r.source === 'auto' && (lastManual === null || (r.reading_date > lastManual.date && r.hours >= lastManual.hours)))
    .map((r) => ({ date: r.reading_date, hours: r.hours }))
    .sort(byDate);
  return { manual, auto };
}

export function seriesPoints(series: MachineSeries): HourPoint[] {
  return [...series.manual, ...series.auto];
}

function valueAtDay(points: HourPoint[], day: number): number {
  if (points.length === 0) return 0;
  if (day < dayNumber(points[0].date)) return 0;
  const last = points[points.length - 1];
  if (day >= dayNumber(last.date)) return last.hours;
  for (let i = 1; i < points.length; i++) {
    const xb = dayNumber(points[i].date);
    if (day <= xb) {
      const a = points[i - 1];
      const xa = dayNumber(a.date);
      return a.hours + ((points[i].hours - a.hours) * (day - xa)) / (xb - xa);
    }
  }
  return last.hours;
}

/** Linear interpolation; 0 before the first reading, flat after the last. */
export function valueAt(points: HourPoint[], iso: string): number {
  return valueAtDay(points, dayNumber(iso));
}

/** First day of every month from `fromIso`'s month through `toIso`'s month. */
export function monthStarts(fromIso: string, toIso: string): string[] {
  let [y, m] = fromIso.split('-').map(Number);
  const [ty, tm] = toIso.split('-').map(Number);
  const out: string[] = [];
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${pad(m)}-01`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

function nextMonth(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
}

/**
 * Hours run in each calendar month, measured only between the machine's first and
 * last reading, so a first reading of 906 h never counts as 906 h in one month.
 * Counter resets clamp to 0.
 */
export function monthlyHours(points: HourPoint[], months: string[]): number[] {
  if (points.length < 2) return months.map(() => 0);
  const first = dayNumber(points[0].date);
  const last = dayNumber(points[points.length - 1].date);
  return months.map((start) => {
    const lo = Math.max(dayNumber(start), first);
    const hi = Math.min(dayNumber(nextMonth(start)), last);
    if (hi <= lo) return 0;
    return Math.max(0, Math.round((valueAtDay(points, hi) - valueAtDay(points, lo)) * 10) / 10);
  });
}

/** Sum over machines of their interpolated value at each date (retired machines stay at their last value). */
export function fleetTotal(pointsList: HourPoint[][], dates: string[]): number[] {
  return dates.map((d) => Math.round(pointsList.reduce((sum, p) => sum + valueAt(p, d), 0) * 10) / 10);
}

const DAYS_PER_MONTH = 30.44;
const STALE_DAYS = 90;

/** Average hours per month over the last `windowDays` (from the first reading if later), never negative. Null below 2 readings or when the newest reading is over 90 days old. */
export function ratePerMonth(points: HourPoint[], today: string, windowDays = 90): number | null {
  if (points.length < 2) return null;
  const end = dayNumber(today);
  if (end - dayNumber(points[points.length - 1].date) > STALE_DAYS) return null;
  const start = Math.max(end - windowDays, dayNumber(points[0].date));
  if (end - start < 7) return null;
  return Math.max(0, ((valueAtDay(points, end) - valueAtDay(points, start)) / (end - start)) * DAYS_PER_MONTH);
}

const SPACES = /[\s\u00a0\u202f]/g;
const THOUSANDS_COMMA = /^\d{1,3}(,\d{3})+$/;

function parseNumber(text: string): number | undefined {
  let s = text.replace(SPACES, '');
  if (s === '') return undefined;
  s = THOUSANDS_COMMA.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return undefined;
  return Number(s);
}

/** A pasted sheet cell: positive hours, or null for empty / zero ("not owned yet") / junk. */
export function parseHoursCell(cell: string): number | null {
  const n = parseNumber(cell);
  return n === undefined || n <= 0 ? null : n;
}

/** A form field: null when empty, undefined when invalid, otherwise the number (0 allowed). */
export function parseHoursInput(text: string): number | null | undefined {
  if (text.replace(SPACES, '') === '') return null;
  return parseNumber(text);
}

const DMY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDateCell(cell: string): string | null {
  const s = cell.trim();
  let y: number;
  let m: number;
  let d: number;
  const dmy = DMY.exec(s);
  const ymd = YMD.exec(s);
  if (dmy) [d, m, y] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
  else if (ymd) [y, m, d] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])];
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

export interface SheetPaste {
  headers: string[];
  rows: { date: string; values: (number | null)[] }[];
  skipped: number;
}

/** Tab-separated copy from Google Sheets: first row = header (first cell ignored), first column = date. */
export function parseSheetPaste(text: string): SheetPaste {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return { headers: [], rows: [], skipped: 0 };
  const headers = lines[0].split('\t').slice(1).map((h) => h.trim());
  while (headers.length && headers[headers.length - 1] === '') headers.pop();
  const rows: SheetPaste['rows'] = [];
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    const date = parseDateCell(cells[0] ?? '');
    if (!date) {
      skipped += 1;
      continue;
    }
    rows.push({ date, values: headers.map((_, i) => parseHoursCell(cells[i + 1] ?? '')) });
  }
  return { headers, rows, skipped };
}

const MODEL_PREFIX = /^(X1C|X1E|P1S|P1P|P2S|A1|H2D|H2S|H2C)/i;

export function guessModel(name: string): string | null {
  const m = MODEL_PREFIX.exec(name.trim());
  return m ? m[1].toUpperCase() : null;
}

const FAMILY_HUE: Record<string, number> = {
  X1C: 212, X1E: 212, P1S: 190, P1P: 190, P2S: 50, A1: 28, H2D: 275, H2S: 170, H2C: 330,
};

export function familyOf(machine: Pick<HourMachine, 'model' | 'name'>): string {
  return (machine.model ?? guessModel(machine.name) ?? '').toUpperCase().replace(/\s.*$/, '') || 'OTHER';
}

/** Live machines grouped by model family (family names sorted), names sorted within a family: the order of the machine rail. */
export function railOrder(machines: HourMachine[]): HourMachine[] {
  const active = machines.filter((m) => !m.retired);
  const families = [...new Set(active.map(familyOf))].sort();
  return families.flatMap((f) => active.filter((m) => familyOf(m) === f).sort((a, b) => a.name.localeCompare(b.name)));
}

/** One stable colour per machine: hue by model family, lightness spread across the family's machines. */
export function machineColors(machines: HourMachine[]): Map<number, string> {
  const families = new Map<string, HourMachine[]>();
  for (const m of [...machines].sort((a, b) => a.name.localeCompare(b.name))) {
    const f = familyOf(m);
    families.set(f, [...(families.get(f) ?? []), m]);
  }
  const colors = new Map<number, string>();
  for (const [family, members] of families) {
    const hue = FAMILY_HUE[family];
    members.forEach((m, i) => {
      const light = members.length === 1 ? 55 : Math.round(40 + (32 * i) / (members.length - 1));
      colors.set(m.id, hue === undefined ? `hsl(0 0% ${light}%)` : `hsl(${hue} 75% ${light}%)`);
    });
  }
  return colors;
}

export type ColumnChoice = 'create' | 'ignore';

export interface ImportColumn {
  header: string;
  action: 'match' | 'create' | 'ignore';
  machineId: number | null;
  model: string | null;
}

export interface ImportPlan {
  columns: ImportColumn[];
  body: HourImportBody;
  dates: number;
  futureRows: number;
}

/**
 * Turn a parsed paste into an import body. Columns match machines by case-insensitive
 * name; an unmatched column is created as a retired machine when it looks like a printer
 * name (else ignored, which keeps the sheet's `Total` column out), unless `choices` says
 * otherwise. Blank and repeated headers are dropped, as are rows dated after `today`.
 */
export function planImport(
  paste: SheetPaste,
  machines: HourMachine[],
  choices: Record<string, ColumnChoice>,
  today: string,
): ImportPlan {
  const byName = new Map(machines.map((m) => [m.name.trim().toLowerCase(), m]));
  const seen = new Set<string>();
  const columns: (ImportColumn | null)[] = paste.headers.map((header) => {
    const k = header.toLowerCase();
    if (!header || seen.has(k)) return null;
    seen.add(k);
    const match = byName.get(k);
    if (match) return { header, action: 'match', machineId: match.id, model: match.model };
    const model = guessModel(header);
    const action = choices[header] ?? (model ? 'create' : 'ignore');
    return { header, action, machineId: null, model };
  });
  const rows = paste.rows.filter((r) => r.date <= today);
  const body: HourImportBody = {
    new_machines: columns
      .filter((c): c is ImportColumn => c !== null && c.action === 'create')
      .map((c) => ({ key: c.header, name: c.header, model: c.model })),
    readings: [],
  };
  for (const row of rows) {
    columns.forEach((c, i) => {
      const hours = row.values[i];
      if (!c || c.action === 'ignore' || hours === null) return;
      body.readings.push(
        c.action === 'match'
          ? { machine_id: c.machineId as number, reading_date: row.date, hours }
          : { key: c.header, reading_date: row.date, hours },
      );
    });
  }
  return {
    columns: columns.filter((c): c is ImportColumn => c !== null),
    body,
    dates: rows.length,
    futureRows: paste.rows.length - rows.length,
  };
}

const isoOfDay = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

export interface ReadingCheck {
  level: 'ok' | 'question';
  reason: 'ok' | 'noReference' | 'backwards' | 'farFromCounter';
  last: HourPoint | null;
  counterDelta: number | null;
  expected: number | null;
}

/** The auto reading's raw counter on `date`, or the first one within 7 days after it. */
function rawAt(auto: HourReading[], date: string): number | null {
  const day = dayNumber(date);
  const hit = auto
    .filter((r) => r.raw_hours != null && dayNumber(r.reading_date) >= day && dayNumber(r.reading_date) - day <= 7)
    .sort((a, b) => a.reading_date.localeCompare(b.reading_date))[0];
  return hit ? (hit.raw_hours as number) : null;
}

/** Sanity-check a typed lifetime-hours reading against the last manual one and how far the printer's own counter has moved since. */
export function checkReading(
  machineId: number,
  typed: number,
  readings: HourReading[],
  counterRawNow: number | null,
): ReadingCheck {
  const mine = readings.filter((r) => r.machine_id === machineId);
  const manual = mine.filter((r) => r.source === 'manual').sort((a, b) => a.reading_date.localeCompare(b.reading_date));
  const newest = manual.length ? manual[manual.length - 1] : null;
  if (!newest) return { level: 'ok', reason: 'noReference', last: null, counterDelta: null, expected: null };
  const last: HourPoint = { date: newest.reading_date, hours: newest.hours };
  const rawThen = rawAt(
    mine.filter((r) => r.source === 'auto'),
    last.date,
  );
  const counterDelta = rawThen !== null && counterRawNow !== null ? counterRawNow - rawThen : null;
  const expected = counterDelta === null ? null : last.hours + counterDelta;
  if (typed < last.hours) return { level: 'question', reason: 'backwards', last, counterDelta, expected };
  if (counterDelta === null || expected === null) return { level: 'ok', reason: 'noReference', last, counterDelta, expected };
  const far = Math.abs(typed - expected) > Math.max(24, 0.2 * counterDelta);
  return { level: far ? 'question' : 'ok', reason: far ? 'farFromCounter' : 'ok', last, counterDelta, expected };
}

export interface Period {
  from: string;
  to: string;
  days: number;
  pace: number;
}

/** Hours per month between each pair of consecutive manual readings (negative clamps to 0). */
export function periodPaces(manual: HourPoint[]): Period[] {
  const out: Period[] = [];
  for (let i = 1; i < manual.length; i++) {
    const a = manual[i - 1];
    const b = manual[i];
    const days = dayNumber(b.date) - dayNumber(a.date);
    out.push({ from: a.date, to: b.date, days, pace: days > 0 ? Math.max(0, ((b.hours - a.hours) / days) * DAYS_PER_MONTH) : 0 });
  }
  return out;
}

/** 'stopped' when the newest period is 30+ days under 1 h/month; 'slowing' when it fell below half the previous pace. */
export function behaviourFlag(periods: Period[]): 'slowing' | 'stopped' | null {
  if (periods.length === 0) return null;
  const newest = periods[periods.length - 1];
  if (newest.days >= 30 && newest.pace < 1) return 'stopped';
  if (periods.length >= 2) {
    const prev = periods[periods.length - 2];
    if (prev.pace > 0 && newest.pace < 0.5 * prev.pace) return 'slowing';
  }
  return null;
}

/** Share of a machine's possible hours (24 h a day) it actually runs. */
export function loadShare(pace: number | null): number | null {
  return pace === null ? null : pace / (24 * DAYS_PER_MONTH);
}

/** ISO date the machine reaches `target` hours at `pace` h/month; null without a usable pace or when already past. */
export function forecastDate(last: HourPoint, pace: number | null, target: number): string | null {
  if (pace === null || pace <= 0 || target <= last.hours) return null;
  return isoOfDay(dayNumber(last.date) + Math.round(((target - last.hours) / pace) * DAYS_PER_MONTH));
}

/** A machine's history re-based to its first reading: day 0 and hours 0 at the start. */
export function sameAgePoints(points: HourPoint[]): { day: number; hours: number }[] {
  if (points.length === 0) return [];
  const d0 = dayNumber(points[0].date);
  return points.map((p) => ({ day: dayNumber(p.date) - d0, hours: p.hours - points[0].hours }));
}

const pointsOf = (series: Map<number, MachineSeries>, readings: HourReading[], id: number) =>
  seriesPoints(series.get(id) ?? machineSeries(readings, id));

export interface FleetFacts {
  lifetime: number;
  thisMonth: number;
  due: number;
  busiest: { id: number; pace: number } | null;
}

/** Headline numbers for the fleet strip: lifetime over every machine, this month and busiest over live ones. */
export function fleetFacts(
  machines: HourMachine[],
  series: Map<number, MachineSeries>,
  readings: HourReading[],
  today: string,
  dueIds: number[],
): FleetFacts {
  const monthStart = `${today.slice(0, 8)}01`;
  let lifetime = 0;
  let thisMonth = 0;
  let busiest: FleetFacts['busiest'] = null;
  for (const m of machines) {
    const pts = pointsOf(series, readings, m.id);
    lifetime += valueAt(pts, today);
    if (m.retired) continue;
    thisMonth += Math.max(0, valueAt(pts, today) - valueAt(pts, monthStart));
    const pace = ratePerMonth(pts, today);
    if (pace !== null && (busiest === null || pace > busiest.pace)) busiest = { id: m.id, pace };
  }
  return { lifetime, thisMonth, due: dueIds.length, busiest };
}

/** Newest manual reading across live machines and how many days ago it was. */
export function gapInfo(
  machines: HourMachine[],
  series: Map<number, MachineSeries>,
  today: string,
): { lastDate: string | null; days: number } {
  let lastDate: string | null = null;
  for (const m of machines) {
    if (m.retired) continue;
    const manual = series.get(m.id)?.manual ?? [];
    const d = manual.length ? manual[manual.length - 1].date : null;
    if (d !== null && (lastDate === null || d > lastDate)) lastDate = d;
  }
  return { lastDate, days: lastDate === null ? 0 : dayNumber(today) - dayNumber(lastDate) };
}
