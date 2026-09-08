import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { sizeMargin, qtyFactor, unitMultiplier, CURVE_DEFAULTS } from '../../utils/pricing';
import { arbDefaults } from './pricingArbitraries';

const RUNS = { seed: 42, numRuns: 200 } as const;

describe('sizeMargin invariants', () => {
  // The docstring promises: "Guards: an unusable K or an inverted M pair
  // collapse to M_MIN; a negative u is treated as 0. Never NaN."
  it('is always finite', () => {
    fc.assert(
      fc.property(fc.double({ min: -1e6, max: 1e9 }), arbDefaults(), (cost, d) => {
        expect(Number.isFinite(sizeMargin(cost, d))).toBe(true);
      }),
      RUNS,
    );
  });

  it('never leaves the [min, max] band it was configured with', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1e6, noNaN: true }), arbDefaults(), (cost, d) => {
        const mMin = d.margin_min_mult ?? CURVE_DEFAULTS.margin_min_mult;
        const mMax = d.margin_max_mult ?? CURVE_DEFAULTS.margin_max_mult;
        const m = sizeMargin(cost, d);
        // An inverted pair collapses to mMin by contract, so the band is
        // whichever way round the two were supplied.
        expect(m).toBeGreaterThanOrEqual(Math.min(mMin, mMax) - 1e-9);
        expect(m).toBeLessThanOrEqual(Math.max(mMin, mMax) + 1e-9);
      }),
      RUNS,
    );
  });

  it('is non-increasing in unit cost — bigger parts never carry more margin', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1e6, noNaN: true }),
        fc.double({ min: 0, max: 1e6, noNaN: true }),
        arbDefaults(),
        (a, b, d) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          expect(sizeMargin(hi, d)).toBeLessThanOrEqual(sizeMargin(lo, d) + 1e-9);
        },
      ),
      RUNS,
    );
  });
});

describe('qtyFactor invariants', () => {
  // "Exactly 1 at q = 1, decreasing towards Q_MIN."
  it('is exactly 1 at quantity 1, for every configuration', () => {
    fc.assert(
      fc.property(arbDefaults(), (d) => {
        expect(qtyFactor(1, d)).toBe(1);
      }),
      RUNS,
    );
  });

  it('stays within (0, 1] and is non-increasing in quantity', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10000 }),
        fc.integer({ min: 1, max: 10000 }),
        arbDefaults(),
        (a, b, d) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          const f = qtyFactor(hi, d);
          expect(Number.isFinite(f)).toBe(true);
          expect(f).toBeGreaterThan(0);
          expect(f).toBeLessThanOrEqual(1 + 1e-9);
          expect(f).toBeLessThanOrEqual(qtyFactor(lo, d) + 1e-9);
        },
      ),
      RUNS,
    );
  });
});

describe('unitMultiplier invariants', () => {
  // "the multiplier is never below 1" — the discount only ever eats margin,
  // never principal.
  it('never drops below 1', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1e6, noNaN: true }),
        fc.integer({ min: 1, max: 10000 }),
        arbDefaults(),
        (cost, qty, d) => {
          expect(unitMultiplier(cost, qty, d)).toBeGreaterThanOrEqual(1 - 1e-9);
        },
      ),
      RUNS,
    );
  });
});
