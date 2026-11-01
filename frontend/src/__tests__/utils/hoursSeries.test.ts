import { describe, expect, it } from 'vitest';
import type { HourMachine, HourReading } from '../../api/client';
import {
  dayNumber,
  fleetTotal,
  guessModel,
  machineColors,
  machineSeries,
  monthStarts,
  monthlyHours,
  parseDateCell,
  parseHoursCell,
  parseHoursInput,
  parseSheetPaste,
  planImport,
  ratePerMonth,
  checkReading,
  periodPaces,
  behaviourFlag,
  loadShare,
  forecastDate,
  sameAgePoints,
  fleetFacts,
  gapInfo,
  seriesPoints,
  valueAt,
} from '../../utils/hoursSeries';

// The operator's Google Sheet, verbatim (0 = machine not owned yet).
const DATES = ['2024-07-19', '2024-10-25', '2025-01-07', '2025-03-11', '2025-07-07', '2026-01-01', '2026-04-25'];
const SHEET: Record<string, number[]> = {
  X1C01: [1470, 1786, 2260, 2500, 2970, 4102, 4102], X1C02: [212, 591, 1069, 1325, 1760, 2696, 2696],
  X1C03: [491, 908, 1364, 1721, 2248, 3500, 3500], X1C04: [243, 752, 1186, 1510, 2063, 3297, 3803],
  X1C05: [0, 205, 605, 980, 1450, 2788, 3336], X1C06: [0, 0, 0, 174, 713, 2039, 2629],
  X1C07: [0, 0, 0, 171, 688, 1629, 2252], X1C08: [0, 0, 0, 63, 673, 1900, 2461],
  X1C09: [0, 0, 0, 0, 0, 821, 1430], A101: [0, 0, 0, 0, 0, 500, 500],
  H2D01: [0, 0, 0, 0, 471, 2178, 2810], H2S01: [0, 0, 0, 0, 0, 861, 1691],
  H2S02: [0, 0, 0, 0, 0, 0, 906], H2S03: [0, 0, 0, 0, 0, 946, 1798], H2S04: [0, 0, 0, 0, 0, 890, 1743],
  H2C01: [0, 0, 0, 0, 0, 0, 345], H2C02: [0, 0, 0, 0, 0, 0, 384], H2C03: [0, 0, 0, 0, 0, 0, 345],
  H2C04: [0, 0, 0, 0, 0, 0, 384],
};
const NAMES = Object.keys(SHEET);
const machines: HourMachine[] = NAMES.map((name, i) => ({
  id: i + 1, printer_id: i + 1, name, model: guessModel(name), retired: false, current_hours: null,
  trust: 'uncalibrated', last_drift_hours: null, calibrated_at: null, counter_raw_hours: null, next_service_hours: null, purchase_price: null, purchase_date: null, added_on: null,
}));
let rid = 0;
const readings: HourReading[] = NAMES.flatMap((name, i) =>
  DATES.flatMap((d, k) =>
    SHEET[name][k] > 0
      ? [{ id: ++rid, machine_id: i + 1, reading_date: d, hours: SHEET[name][k], source: 'manual' as const, raw_hours: null }]
      : [],
  ),
);
const pts = (name: string) => seriesPoints(machineSeries(readings, NAMES.indexOf(name) + 1));

describe('series maths', () => {
  it('fleet total on 25/04/2026 counts every machine (the sheet formula skipped the H2s)', () => {
    expect(fleetTotal(NAMES.map(pts), ['2026-04-25'])).toEqual([37115]);
  });

  it('interpolates linearly, is 0 before the first reading and flat after the last', () => {
    const x = pts('X1C04');
    expect(valueAt(x, '2024-07-01')).toBe(0);
    expect(valueAt(x, '2026-01-01')).toBe(3297);
    expect(valueAt(x, '2026-02-26')).toBeCloseTo(3297 + (506 * 56) / 114, 5);
    expect(valueAt(x, '2026-10-04')).toBe(3803);
  });

  it('keeps only auto readings newer than the last manual one', () => {
    const r: HourReading[] = [
      { id: 1, machine_id: 9, reading_date: '2026-04-20', hours: 124, source: 'auto', raw_hours: null },
      { id: 2, machine_id: 9, reading_date: '2026-04-25', hours: 3803, source: 'manual', raw_hours: null },
      { id: 3, machine_id: 9, reading_date: '2026-05-01', hours: 3840, source: 'auto', raw_hours: null },
    ];
    expect(machineSeries(r, 9)).toEqual({
      manual: [{ date: '2026-04-25', hours: 3803 }],
      auto: [{ date: '2026-05-01', hours: 3840 }],
    });
  });

  it('drops a newer auto reading that is lower than the last manual one (uncalibrated counter)', () => {
    const base: HourReading[] = [{ id: 1, machine_id: 9, reading_date: '2026-04-25', hours: 3803, source: 'manual', raw_hours: null }];
    const low: HourReading = { id: 2, machine_id: 9, reading_date: '2026-10-04', hours: 124, source: 'auto', raw_hours: null };
    const high: HourReading = { id: 3, machine_id: 9, reading_date: '2026-10-04', hours: 3840, source: 'auto', raw_hours: null };
    expect(machineSeries([...base, low], 9).auto).toEqual([]);
    expect(machineSeries([...base, high], 9).auto).toEqual([{ date: '2026-10-04', hours: 3840 }]);
  });

  it('buckets hours by calendar month without counting lifetime hours before the first reading', () => {
    const months = monthStarts('2026-03-15', '2026-05-02');
    expect(months).toEqual(['2026-03-01', '2026-04-01', '2026-05-01']);
    const x = pts('X1C04'); // 3297 on 01/01 → 3803 on 25/04 = 506 h over 114 days
    const [mar, apr, may] = monthlyHours(x, months);
    expect(mar).toBeCloseTo((506 * 31) / 114, 1);
    expect(apr).toBeCloseTo((506 * 24) / 114, 1);
    expect(may).toBe(0);
    // H2S02's single reading (906 h) must not show up as 906 h in April
    expect(monthlyHours(pts('H2S02'), ['2026-04-01'])).toEqual([0]);
  });

  it('clamps counter resets to zero instead of negative months', () => {
    const p = [{ date: '2026-01-01', hours: 500 }, { date: '2026-02-01', hours: 10 }];
    expect(monthlyHours(p, ['2026-01-01'])).toEqual([0]);
  });

  it('rate per month over the last 90 days', () => {
    expect(ratePerMonth(pts('X1C04'), '2026-04-25')).toBeCloseTo(135.1, 0);
    expect(ratePerMonth(pts('A101'), '2026-04-25')).toBe(0);
    expect(ratePerMonth(pts('H2C01'), '2026-04-25')).toBeNull(); // a single reading has no rate
  });

  it('is null when the last point is older than 90 days (stale rate)', () => {
    expect(ratePerMonth(pts('X1C04'), '2026-07-24')).not.toBeNull(); // 90 days exactly
    expect(ratePerMonth(pts('X1C04'), '2026-07-25')).toBeNull(); // 91 days
  });

  it('never returns a negative rate', () => {
    const p = [{ date: '2026-01-01', hours: 500 }, { date: '2026-03-01', hours: 10 }];
    expect(ratePerMonth(p, '2026-03-01')).toBe(0);
  });
});

describe('parsing', () => {
  it.each([
    ['1470', 1470], ['1 470', 1470], ['1\u00a0470', 1470], ['1\u202f470', 1470],
    ['471,5', 471.5], ['1,470', 1470], ['12,345,678', 12345678], ['0', null], ['', null], ['-5', null], ['abc', null],
  ])('parseHoursCell(%j) = %j', (cell, expected) => {
    expect(parseHoursCell(cell)).toBe(expected);
  });

  it.each([
    ['', null], ['0', 0], ['3 803', 3803], ['3803,5', 3803.5], ['x', undefined], ['-1', undefined],
  ])('parseHoursInput(%j) = %j', (text, expected) => {
    expect(parseHoursInput(text)).toBe(expected);
  });

  it.each([
    ['19/07/2024', '2024-07-19'], ['1/1/2026', '2026-01-01'], ['2026-04-25', '2026-04-25'],
    ['31/02/2026', null], ['Date', null], ['', null],
  ])('parseDateCell(%j) = %j', (cell, expected) => {
    expect(parseDateCell(cell)).toBe(expected);
  });

  it('parses a Google Sheets copy, skipping rows without a date', () => {
    const text = 'Date\tX1C01\tH2S02\tTotal\r\n19/07/2024\t1470\t0\t1470\n\t\t\t0\n25/04/2026\t4 102\t906\t5008\n';
    expect(parseSheetPaste(text)).toEqual({
      headers: ['X1C01', 'H2S02', 'Total'],
      rows: [
        { date: '2024-07-19', values: [1470, null, 1470] },
        { date: '2026-04-25', values: [4102, 906, 5008] },
      ],
      skipped: 1,
    });
  });
});

describe('planImport', () => {
  const fenrir: HourMachine[] = [
    { id: 7, printer_id: 3, name: 'X1C04', model: 'X1C', retired: false, current_hours: 124,
      trust: 'uncalibrated', last_drift_hours: null, calibrated_at: null, counter_raw_hours: null, next_service_hours: null, purchase_price: null, purchase_date: null, added_on: null },
  ];
  const paste = parseSheetPaste(
    'Date\tx1c04\tX1C01\tTotal\t\n25/04/2026\t3803\t4102\t7905\t\n05/10/2099\t1\t1\t2\t\n',
  );

  it('matches by name, creates printer-like columns as retired, ignores Total, blanks and future rows', () => {
    const plan = planImport(paste, fenrir, {}, '2026-10-04');
    expect(plan.columns.map((c) => [c.header, c.action])).toEqual([
      ['x1c04', 'match'], ['X1C01', 'create'], ['Total', 'ignore'],
    ]);
    expect(plan.futureRows).toBe(1);
    expect(plan.body).toEqual({
      new_machines: [{ key: 'X1C01', name: 'X1C01', model: 'X1C' }],
      readings: [
        { machine_id: 7, reading_date: '2026-04-25', hours: 3803 },
        { key: 'X1C01', reading_date: '2026-04-25', hours: 4102 },
      ],
    });
  });

  it('honours an explicit ignore choice', () => {
    const plan = planImport(paste, fenrir, { X1C01: 'ignore' }, '2026-10-04');
    expect(plan.body.new_machines).toEqual([]);
    expect(plan.body.readings).toHaveLength(1);
  });
});

describe('colours', () => {
  it('gives each machine a stable colour, shaded within its model family', () => {
    const colors = machineColors(machines);
    expect(colors.get(1)).toMatch(/^hsl\(212 /); // X1C family hue
    expect(colors.get(1)).not.toBe(colors.get(2));
    expect(new Set(colors.values()).size).toBe(machines.length);
  });

  it('guesses the model from a printer-style name', () => {
    expect(guessModel('X1C01')).toBe('X1C');
    expect(guessModel('h2s04')).toBe('H2S');
    expect(guessModel('A101')).toBe('A1');
    expect(guessModel('Total')).toBeNull();
  });
});

const mk = (id: number, machine_id: number, reading_date: string, hours: number, source: 'manual' | 'auto', raw_hours: number | null = null): HourReading =>
  ({ id, machine_id, reading_date, hours, source, raw_hours });

describe('checkReading', () => {
  // last manual 1743 on D, counter raw 500 on D and 1112 now (delta 612)
  const base = [mk(1, 1, '2026-04-25', 1743, 'manual'), mk(2, 1, '2026-04-25', 1743, 'auto', 500)];

  it('questions a value below the last manual reading', () => {
    const c = checkReading(1, 1700, base, 1112);
    expect(c.level).toBe('question');
    expect(c.reason).toBe('backwards');
    expect(c.last).toEqual({ date: '2026-04-25', hours: 1743 });
  });

  it('questions a jump far from the counter delta', () => {
    const c = checkReading(1, 2743, base, 1112);
    expect(c).toMatchObject({ level: 'question', reason: 'farFromCounter', counterDelta: 612, expected: 2355 });
  });

  it('accepts within max(24h, 20%)', () => {
    expect(checkReading(1, 2300, base, 1112)).toMatchObject({ level: 'ok', reason: 'ok', expected: 2355 }); // diff 55 < 122.4
  });

  it('uses the 24 h floor on a small delta', () => {
    // delta 40 -> tolerance 24
    expect(checkReading(1, 1743 + 70, base, 540).level).toBe('question'); // diff 30
    expect(checkReading(1, 1743 + 60, base, 540).level).toBe('ok'); // diff 20
  });

  it('takes the first raw reading within 7 days after D when D has none', () => {
    const r = [mk(1, 1, '2026-04-25', 1743, 'manual'), mk(2, 1, '2026-04-28', 1750, 'auto', 500), mk(3, 1, '2026-05-10', 1790, 'auto', 900)];
    expect(checkReading(1, 2000, r, 1112).counterDelta).toBe(612);
  });

  it('returns noReference without raw readings or without a manual', () => {
    const noRaw = [mk(1, 1, '2026-04-25', 1743, 'manual'), mk(2, 1, '2026-04-25', 1743, 'auto')];
    expect(checkReading(1, 2000, noRaw, 1112)).toMatchObject({ level: 'ok', reason: 'noReference', counterDelta: null, expected: null });
    expect(checkReading(1, 2000, base, null)).toMatchObject({ level: 'ok', reason: 'noReference' });
    expect(checkReading(2, 2000, base, 1112)).toEqual({ level: 'ok', reason: 'noReference', last: null, counterDelta: null, expected: null });
  });

  it('accepts locale-formatted input via parseHoursInput', () => {
    const typed = parseHoursInput('1 234,5') as number;
    expect(typed).toBe(1234.5);
    const r = [mk(1, 1, '2026-04-25', 1000, 'manual'), mk(2, 1, '2026-04-25', 1000, 'auto', 100)];
    expect(checkReading(1, typed, r, 340).level).toBe('ok');
  });
});

describe('pace and flags', () => {
  it('periodPaces on the sheet H2S04', () => {
    const p = periodPaces(pts('H2S04'));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ from: '2026-01-01', to: '2026-04-25', days: 114 });
    expect(p[0].pace).toBeCloseTo((853 / 114) * 30.44, 5);
  });

  it('clamps a negative pace to 0', () => {
    expect(periodPaces([{ date: '2026-01-01', hours: 500 }, { date: '2026-03-01', hours: 10 }])[0].pace).toBe(0);
  });

  const per = (pace: number, days = 60) => ({ from: '2026-01-01', to: '2026-03-01', days, pace });
  it('flags slowing under half the previous pace, not at 0.58', () => {
    expect(behaviourFlag([per(290), per(169)])).toBeNull();
    expect(behaviourFlag([per(290), per(120)])).toBe('slowing');
  });

  it('flags stopped after 35 days at 0.5 h/month', () => {
    expect(behaviourFlag([per(0.5, 35)])).toBe('stopped');
    expect(behaviourFlag([per(0.5, 20)])).toBeNull();
    expect(behaviourFlag([])).toBeNull();
  });

  it('loadShare is pace over a full month of 24 h days', () => {
    expect(loadShare(null)).toBeNull();
    expect(loadShare(24 * 30.44)).toBe(1);
  });
});

describe('forecast and same age', () => {
  it('forecastDate from 1743 at 228 h/mo to 2500 lands about 100 days later', () => {
    const d = forecastDate({ date: '2026-04-25', hours: 1743 }, 228, 2500) as string;
    expect(dayNumber(d) - dayNumber('2026-04-25')).toBe(Math.round(((2500 - 1743) / 228) * 30.44));
    expect(dayNumber(d) - dayNumber('2026-04-25')).toBeGreaterThanOrEqual(100);
  });

  it('forecastDate is null without pace or when the target is passed', () => {
    const last = { date: '2026-04-25', hours: 1743 };
    expect(forecastDate(last, null, 2500)).toBeNull();
    expect(forecastDate(last, 0, 2500)).toBeNull();
    expect(forecastDate(last, 100, 1743)).toBeNull();
  });

  it('sameAgePoints starts at day 0 hours 0', () => {
    expect(sameAgePoints([])).toEqual([]);
    expect(sameAgePoints([{ date: '2026-01-01', hours: 500 }, { date: '2026-01-11', hours: 530 }])).toEqual([
      { day: 0, hours: 0 }, { day: 10, hours: 30 },
    ]);
  });
});

describe('fleet facts', () => {
  const ms = [machines[3], machines[NAMES.indexOf('H2S04')], { ...machines[0], retired: true }];
  const series = (id: number) => machineSeries(readings, id);
  const seriesOf = new Map(ms.map((m) => [m.id, series(m.id)]));

  it('lifetime sums sold machines, due counts ids, busiest picks highest pace', () => {
    const f = fleetFacts(ms, seriesOf, readings, '2026-04-25', [1, 2]);
    const expected = ms.reduce((s, m) => s + valueAt(seriesPoints(seriesOf.get(m.id)!), '2026-04-25'), 0);
    expect(f.lifetime).toBeCloseTo(expected, 5);
    expect(f.due).toBe(2);
    const rates = ms.filter((m) => !m.retired).map((m) => ({ id: m.id, pace: ratePerMonth(seriesPoints(seriesOf.get(m.id)!), '2026-04-25') as number }));
    const top = rates.reduce((a, b) => (b.pace > a.pace ? b : a));
    expect(f.busiest?.id).toBe(top.id);
    expect(f.busiest?.pace).toBeCloseTo(top.pace, 5);
    expect(f.thisMonth).toBeGreaterThan(0);
  });

  it('busiest is null without any rate', () => {
    expect(fleetFacts([machines[0]], new Map([[1, { manual: [], auto: [] }]]), [], '2026-04-25', []).busiest).toBeNull();
  });

  it('gapInfo reports days since the newest manual reading of live machines', () => {
    expect(gapInfo(ms, seriesOf, '2026-05-05')).toEqual({ lastDate: '2026-04-25', days: 10 });
    expect(gapInfo([], new Map(), '2026-05-05')).toEqual({ lastDate: null, days: 0 });
  });
});
