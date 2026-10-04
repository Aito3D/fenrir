import { describe, expect, it } from 'vitest';
import type { HourMachine, HourReading } from '../../api/client';
import {
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
}));
let rid = 0;
const readings: HourReading[] = NAMES.flatMap((name, i) =>
  DATES.flatMap((d, k) =>
    SHEET[name][k] > 0
      ? [{ id: ++rid, machine_id: i + 1, reading_date: d, hours: SHEET[name][k], source: 'manual' as const }]
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
      { id: 1, machine_id: 9, reading_date: '2026-04-20', hours: 124, source: 'auto' },
      { id: 2, machine_id: 9, reading_date: '2026-04-25', hours: 3803, source: 'manual' },
      { id: 3, machine_id: 9, reading_date: '2026-05-01', hours: 3840, source: 'auto' },
    ];
    expect(machineSeries(r, 9)).toEqual({
      manual: [{ date: '2026-04-25', hours: 3803 }],
      auto: [{ date: '2026-05-01', hours: 3840 }],
    });
  });

  it('drops a newer auto reading that is lower than the last manual one (uncalibrated counter)', () => {
    const base: HourReading[] = [{ id: 1, machine_id: 9, reading_date: '2026-04-25', hours: 3803, source: 'manual' }];
    const low: HourReading = { id: 2, machine_id: 9, reading_date: '2026-10-04', hours: 124, source: 'auto' };
    const high: HourReading = { id: 3, machine_id: 9, reading_date: '2026-10-04', hours: 3840, source: 'auto' };
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
    { id: 7, printer_id: 3, name: 'X1C04', model: 'X1C', retired: false, current_hours: 124 },
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
