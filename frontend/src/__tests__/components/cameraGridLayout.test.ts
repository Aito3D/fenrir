import { describe, it, expect } from 'vitest';
import { computeWallFit } from '../../components/cameraGridLayout';

describe('computeWallFit', () => {
  it('returns null for degenerate inputs', () => {
    expect(computeWallFit({ count: 0, width: 1000, height: 800, gap: 8 })).toBeNull();
    expect(computeWallFit({ count: 5, width: 0, height: 800, gap: 8 })).toBeNull();
    expect(computeWallFit({ count: 5, width: 1000, height: 0, gap: 8 })).toBeNull();
  });

  it('a single tile fills whichever axis binds first', () => {
    // Wide box: height binds. heightCap = 500 * 16/9 = 888
    const fit = computeWallFit({ count: 1, width: 2000, height: 500, gap: 8 })!;
    expect(fit.cols).toBe(1);
    expect(fit.tileWidth).toBe(Math.floor(500 * (16 / 9)));
    // Tall box: width binds.
    const fit2 = computeWallFit({ count: 1, width: 600, height: 2000, gap: 8 })!;
    expect(fit2.cols).toBe(1);
    expect(fit2.tileWidth).toBe(600);
  });

  it('the kiosk screenshot case: 20 tiles on a 1990x1010 wall picks 5 columns, not 6', () => {
    // The breakpoint classes rendered 6 columns here, leaving ~260px of black
    // below the last row. Best-fit chooses 5: 4 rows of taller tiles that use
    // the height.
    const fit = computeWallFit({ count: 20, width: 1990, height: 1010, gap: 8 })!;
    expect(fit.cols).toBe(5);
    // width-limited at 5 cols: (1990 - 32) / 5
    expect(fit.tileWidth).toBe(Math.floor((1990 - 32) / 5));
    // And the resulting 4 rows genuinely fit the height.
    const rows = Math.ceil(20 / fit.cols);
    const totalH = rows * (fit.tileWidth * 9) / 16 + (rows - 1) * 8;
    expect(totalH).toBeLessThanOrEqual(1010);
  });

  it('never lets a row overflow the box vertically', () => {
    for (const count of [2, 3, 7, 11, 20, 33]) {
      const fit = computeWallFit({ count, width: 1280, height: 720, gap: 16 })!;
      const rows = Math.ceil(count / fit.cols);
      const totalH = rows * (fit.tileWidth * 9) / 16 + (rows - 1) * 16;
      expect(totalH).toBeLessThanOrEqual(720 + rows); // +rows: Math.floor rounding slack
    }
  });

  it('a spotlight (2x2 tile) consumes 4 slots and forces at least 2 columns', () => {
    const noSpot = computeWallFit({ count: 4, width: 1000, height: 5000, gap: 8 })!;
    expect(noSpot.cols).toBe(1); // tall box: single column is biggest
    const withSpot = computeWallFit({ count: 4, spotlights: 1, width: 1000, height: 5000, gap: 8 })!;
    expect(withSpot.cols).toBeGreaterThanOrEqual(2);
  });

  it('spotlights are clamped to count', () => {
    const fit = computeWallFit({ count: 2, spotlights: 9, width: 1600, height: 900, gap: 8 });
    expect(fit).not.toBeNull();
  });

  it('prefers fewer columns on a tile-width tie', () => {
    // Very tall box: every column count is width-limited only for cols where
    // rows fit; with abundant height, cols=1 always gives the widest tile.
    const fit = computeWallFit({ count: 3, width: 900, height: 100000, gap: 8 })!;
    expect(fit.cols).toBe(1);
  });
});
