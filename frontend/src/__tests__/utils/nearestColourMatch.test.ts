/**
 * Regression tests for slot-order-dependent colour matching (#2804), frontend side.
 *
 * Three matchers in the interface fell back to "first spool within tolerance"
 * when no exact colour was loaded, so the winner depended on AMS slot order.
 * They now share `matchFilamentsToTrays` with the scheduler's equivalent, so
 * the dialog cannot promise a spool the backend would not have picked.
 *
 * The worked example is the maintainer's: required `#3A7BD5`, a purple
 * `#6253AD` in tray 1 (40/40/40 off — admitted) and a near-identical `#3B7AD2`
 * in tray 3.
 *
 * Ranking is by CIEDE2000 delta-E, matching the backend's
 * `perceptual_color_distance`, so those two are ~18.5 and ~0.5 apart rather
 * than the ~69 and ~3 an RGB metric reported. A colour outside the old
 * per-channel box is ranked too: the nearest tray wins, however far.
 */

import { describe, expect, it } from 'vitest';
import { colorDistance, matchFilamentsToTrays } from '../../utils/amsHelpers';

const REQUIRED = '#3A7BD5';
const NEAR = '3B7AD2FF';
const FAR_BUT_ADMITTED = '6253ADFF';

const tray = (globalTrayId: number, color: string, extruderId?: number) => ({
  globalTrayId,
  color,
  type: 'PETG',
  extruderId,
});
const req = (color: string, nozzle_id?: number) => ({ type: 'PETG', color, nozzle_id });
const ids = (picked: ({ globalTrayId: number } | undefined)[]) => picked.map((t) => t?.globalTrayId);
const pick = (candidates: ReturnType<typeof tray>[], required = REQUIRED) =>
  ids(matchFilamentsToTrays([req(required)], candidates))[0];

describe('colorDistance', () => {
  it('is zero for the same colour', () => {
    expect(colorDistance('#3A7BD5', '3A7BD5FF')).toBe(0);
  });

  it('ignores alpha so a transparent filament matches itself', () => {
    expect(colorDistance('#76D9F4', '76D9F400')).toBe(0);
  });

  it('is perceptual rather than per-channel', () => {
    // CIEDE2000 delta-E, where ~1 is a just-noticeable difference. The backend
    // must give the same answer for the same pair.
    expect(colorDistance('#000000', '#282828')).toBeCloseTo(9.91, 2);
    expect(colorDistance(NEAR, REQUIRED)).toBeCloseTo(0.4797, 3);
    expect(colorDistance(FAR_BUT_ADMITTED, REQUIRED)).toBeCloseTo(18.4853, 3);
  });

  it('ranks a perceptually nearer colour above a numerically nearer one', () => {
    // Against a green requirement, a purple is closer by RGB distance
    // (49.7 vs 56.9) and much further perceptually. Both are inside the
    // tolerance, so the ranking alone decides which one prints.
    const green = '#1E4821';
    expect(colorDistance('#43683E', green)!).toBeLessThan(colorDistance('#38202F', green)!);
  });

  it('is symmetric, so which spool is listed first cannot change the answer', () => {
    expect(colorDistance(NEAR, REQUIRED)).toBeCloseTo(colorDistance(REQUIRED, NEAR)!, 12);
  });

  it('returns null for unusable input rather than a number', () => {
    expect(colorDistance(undefined, REQUIRED)).toBeNull();
    expect(colorDistance('', REQUIRED)).toBeNull();
    expect(colorDistance('#abc', REQUIRED)).toBeNull();
    expect(colorDistance('#zzzzzz', REQUIRED)).toBeNull();
  });
});

describe('matchFilamentsToTrays', () => {
  it('picks the closest colour, not the first one', () => {
    expect(pick([tray(1, FAR_BUT_ADMITTED), tray(3, NEAR)])).toBe(3);
  });

  it('gives the same answer whichever order the trays arrive in', () => {
    expect(pick([tray(1, FAR_BUT_ADMITTED), tray(3, NEAR)])).toBe(3);
    expect(pick([tray(3, NEAR), tray(1, FAR_BUT_ADMITTED)])).toBe(3);
  });

  it('keeps the incoming order on a tie, so prefer-lowest still decides', () => {
    // Same colour in both trays, so the tie is exact. Two *different* colours
    // at equal RGB distance are not perceptually tied — that is the whole point
    // of the metric — so they cannot be used to test this any more.
    expect(pick([tray(2, NEAR), tray(7, NEAR)])).toBe(2);
    expect(pick([tray(7, NEAR), tray(2, NEAR)])).toBe(7);
  });

  it('ranks a tray with no usable colour last instead of throwing', () => {
    expect(pick([tray(1, ''), tray(3, NEAR)])).toBe(3);
    expect(pick([tray(1, '')])).toBe(1);
  });

  // Black/orange/blue/white on black/grey/yellow/blue: no close colour loaded
  // used to mean "first free tray of the type", which printed blue in yellow
  // with a blue spool two slots along.
  const LOADED = [tray(0, '161616FF'), tray(1, 'DCDCDCFF'), tray(2, 'FFF144FF'), tray(3, '46A8F9FF')];

  it('gives a far colour the nearest tray, not the next one', () => {
    const required = [req('#000000'), req('#FF8000'), req('#0A2CA5'), req('#FFFFFF')];
    expect(ids(matchFilamentsToTrays(required, LOADED))).toEqual([0, 2, 3, 1]);
  });

  it('does not depend on the order of filaments in the file', () => {
    // The pale filament comes first and would have taken the blue tray the
    // blue filament matches far better.
    const loaded = [tray(3, '46A8F9FF'), tray(1, 'DCDCDCFF')];
    expect(ids(matchFilamentsToTrays([req('#9FC5E8'), req('#46A8F9')], loaded))).toEqual([1, 3]);
  });

  it('never reaches a tray on the other nozzle, unless a switch routes it', () => {
    const loaded = [tray(0, 'FF8000FF', 0), tray(1, 'DCDCDCFF', 1)];
    expect(ids(matchFilamentsToTrays([req('#FF8000', 1)], loaded))).toEqual([1]);
    expect(ids(matchFilamentsToTrays([req('#FF8000', 1)], loaded, { ftsActive: true }))).toEqual([0]);
  });

  it('prefers a matching colour of another variant over the same variant in the wrong colour', () => {
    const loaded = [
      { ...tray(0, '3A7BD5FF'), trayInfoIdx: 'GFG00' },
      { ...tray(1, 'FF0000FF'), trayInfoIdx: 'GFG99' },
    ];
    const required = [{ ...req(REQUIRED), tray_info_idx: 'GFG99' }];
    expect(ids(matchFilamentsToTrays(required, loaded))).toEqual([0]);
  });
});

describe('buildFilamentComparison row order', () => {
  it('lists right-nozzle (main) filaments before left-nozzle ones, slot order within', async () => {
    const { buildFilamentComparison } = await import('../../hooks/useFilamentMapping');
    const req = (slot_id: number, nozzle_id: number) => ({ slot_id, nozzle_id, type: 'PLA', color: '#FFFFFF', used_grams: 1 });
    const rows = buildFilamentComparison(
      { filaments: [req(1, 1), req(2, 0), req(3, 1), req(4, 0)] } as never,
      [],
      {},
    );
    expect(rows.map((r) => r.slot_id)).toEqual([2, 4, 1, 3]);
  });
});

describe('rankTraysForPicker', () => {
  it('puts usable trays first, nearest colour on top, and unusable ones after in slot order', async () => {
    const { rankTraysForPicker } = await import('../../utils/amsHelpers');
    const tray = (globalTrayId: number, extruderId: number, color: string, type = 'PLA') => ({ globalTrayId, extruderId, color, type });
    const trays = [
      tray(0, 0, '#FF0000'), // other nozzle, exact colour: still last
      tray(1, 0, '#FFFFFF'),
      tray(4, 1, '#0000FF'),
      tray(5, 1, '#00FF00', 'PETG'), // usable but wrong type: after the PLA ones
      tray(6, 1, '#EE1111'),
    ];
    const ranked = rankTraysForPicker({ type: 'PLA', color: '#FF0000', nozzle_id: 1 }, trays, (t) => t.extruderId === 1);
    expect(ranked.map((t) => t.globalTrayId)).toEqual([6, 4, 5, 0, 1]);
  });
});

describe('colour within tolerance outranks variant', () => {
  // White Bambu PLA Basic (GFA00) on a printer with a yellow Basic spool and a
  // light-grey generic PLA: grey is 35/35/35 off (inside tolerance), so it wins.
  const white = { type: 'PLA', color: '#FFFFFF', tray_info_idx: 'GFA00' };
  const yellowBasic = { globalTrayId: 1, type: 'PLA', color: 'FFF144FF', trayInfoIdx: 'GFA00' };
  const greyGeneric = { globalTrayId: 2, type: 'PLA', color: 'DCDCDCFF', trayInfoIdx: 'GFL99' };

  it('picks the light-grey generic over the yellow Basic', () => {
    expect(ids(matchFilamentsToTrays([white], [yellowBasic, greyGeneric]))).toEqual([2]);
  });

  it('still prefers the same variant among colour matches (#2650)', () => {
    const whiteBasic = { ...yellowBasic, globalTrayId: 3, color: 'F5F5F5FF' };
    expect(ids(matchFilamentsToTrays([white], [greyGeneric, whiteBasic]))).toEqual([3]);
  });

  it('falls back to the variant when no colour is within tolerance', () => {
    const black = { ...greyGeneric, color: '000000FF' };
    expect(ids(matchFilamentsToTrays([white], [black, yellowBasic]))).toEqual([1]);
  });
});
