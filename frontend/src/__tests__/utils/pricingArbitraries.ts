// Shared fast-check arbitraries for the pricing engine property tests.
//
// This file is intentionally NOT named `*.test.ts` — Vitest's include glob
// (`src/**/*.{test,spec}.{ts,tsx}`) collects every matching file, and
// importing a collected test file from another test file re-registers its
// `describe`/`it` blocks under the importer, running them a second time.
// Keeping the arbitraries in a plain module lets multiple property-test
// files (pricing.properties.test.ts now, more in later tasks) share one
// generator without ever being collected or executed themselves.

import fc from 'fast-check';
import type { PricingDefaults } from '../../utils/pricing';

/** Every field the engine reads, generated across its hostile range: the
 *  curve params are optional in the type and the engine is documented to
 *  fall back to CURVE_DEFAULTS when they are unusable, so the generator must
 *  be free to produce unusable ones (k <= 0, an inverted min/max pair, a
 *  qty_min_factor outside (0, 1]). */
export const arbDefaults = (): fc.Arbitrary<PricingDefaults> =>
  fc.record({
    electricity_tariff: fc.double({ min: 0, max: 500, noNaN: true }),
    labor_rate_per_hour: fc.double({ min: 0, max: 20000, noNaN: true }),
    consumables_packaging_flat: fc.double({ min: 0, max: 1000, noNaN: true }),
    failure_rate_pct: fc.double({ min: 0, max: 100, noNaN: true }),
    prototype_rate_pct: fc.double({ min: 0, max: 100, noNaN: true }),
    ads_rate_pct: fc.double({ min: 0, max: 100, noNaN: true }),
    filament_markup_pct: fc.double({ min: 0, max: 200, noNaN: true }),
    global_markup_pct: fc.double({ min: 0, max: 200, noNaN: true }),
    tax_pct: fc.double({ min: 0, max: 30, noNaN: true }),
    default_difficulty_pct: fc.double({ min: 50, max: 400, noNaN: true }),
    stuff_markup_pct: fc.double({ min: 0, max: 100, noNaN: true }),
    base_fee_flat: fc.double({ min: 0, max: 5000, noNaN: true }),
    margin_min_mult: fc.double({ min: -1, max: 3, noNaN: true }),
    margin_max_mult: fc.double({ min: -1, max: 3, noNaN: true }),
    margin_k: fc.double({ min: -10, max: 500, noNaN: true }),
    qty_min_factor: fc.double({ min: -1, max: 2, noNaN: true }),
    qty_k: fc.double({ min: -10, max: 100, noNaN: true }),
    min_task_price: fc.double({ min: 0, max: 5000, noNaN: true }),
    rush_pct: fc.double({ min: 0, max: 100, noNaN: true }),
  });
