import { describe, it, expect } from 'vitest';
import {
  estimateArchiveSalePrice,
  estimateFilamentCost,
  calculatorPrefillUrl,
  matchCalculatorFilament,
  matchCalculatorPrinter,
  medianUnitCost,
  MEDIAN_MAX_SAMPLES,
  type ArchivePricingSource,
  type NamedCalculatorFilament,
  type NamedCalculatorPrinter,
} from '../../utils/archivePricing';
import { computePricing, type PricingDefaults } from '../../utils/pricing';

const filaments: NamedCalculatorFilament[] = [
  { id: 1, name: 'PLA basique', cost_per_kg: 3731, sale_price_per_kg: 5597, difficulty_pct: 150 },
  { id: 2, name: 'PETG', cost_per_kg: 4200, sale_price_per_kg: 6300, difficulty_pct: 175 },
];

const filamentsWithMaterial: NamedCalculatorFilament[] = [
  { id: 1, name: 'SUNLU Premium', material: 'PETG', cost_per_kg: 4200, sale_price_per_kg: 6300, difficulty_pct: 175 },
  { id: 2, name: 'Bambu Lab PLA', material: 'PLA', cost_per_kg: 3731, sale_price_per_kg: 5597, difficulty_pct: 150 },
];

const printers: NamedCalculatorPrinter[] = [
  {
    id: 1,
    name: 'H2S',
    purchase_price: 347000,
    lifetime_years: 2,
    daily_usage_hours: 5,
    power_watts: 400,
    repair_rate_pct: 30,
  },
];

const twoPrinters: NamedCalculatorPrinter[] = [
  ...printers,
  {
    id: 2,
    name: 'A1 Mini',
    purchase_price: 40000,
    lifetime_years: 2,
    daily_usage_hours: 5,
    power_watts: 150,
    repair_rate_pct: 30,
  },
];

const defaults: PricingDefaults = {
  electricity_tariff: 120,
  labor_rate_per_hour: 3000,
  consumables_packaging_flat: 30,
  failure_rate_pct: 30,
  prototype_rate_pct: 30,
  ads_rate_pct: 5,
  filament_markup_pct: 5,
  global_markup_pct: 50,
  tax_pct: 13,
  default_difficulty_pct: 150,
  stuff_markup_pct: 20,
};

const archive: ArchivePricingSource = {
  filament_used_grams: 40,
  print_time_seconds: 7200,
  actual_time_seconds: null,
  filament_type: 'PLA',
};

describe('matchCalculatorFilament', () => {
  it('matches when the calculator name contains the archive type', () => {
    expect(matchCalculatorFilament('PLA', filaments)).toEqual({ filament: filaments[0], matched: true });
  });

  it('matches case-insensitively', () => {
    expect(matchCalculatorFilament('pla', filaments)).toEqual({ filament: filaments[0], matched: true });
    expect(matchCalculatorFilament('petg', filaments)).toEqual({ filament: filaments[1], matched: true });
  });

  it('matches when the archive type contains the calculator name', () => {
    expect(matchCalculatorFilament('PETG HF', filaments)).toEqual({ filament: filaments[1], matched: true });
  });

  it('matches on the material field even when the display name differs', () => {
    expect(matchCalculatorFilament('PETG', filamentsWithMaterial)).toEqual({
      filament: filamentsWithMaterial[0],
      matched: true,
    });
  });

  it('prefers a material match over a name match', () => {
    // Filament #1's NAME contains "PLA" but its material is PETG; filament
    // #2's MATERIAL is PLA. The material pass must win over the name pass.
    const tricky: NamedCalculatorFilament[] = [
      { id: 1, name: 'PLA-look Silk', material: 'PETG', cost_per_kg: 1, sale_price_per_kg: 2, difficulty_pct: 100 },
      { id: 2, name: 'Generic', material: 'PLA', cost_per_kg: 1, sale_price_per_kg: 2, difficulty_pct: 100 },
    ];
    expect(matchCalculatorFilament('PLA', tricky)).toEqual({ filament: tricky[1], matched: true });
  });

  it('picks the cheapest profile when several match the same material', () => {
    const asaProfiles: NamedCalculatorFilament[] = [
      { id: 1, name: 'Bambu Lab ASA', material: 'ASA', cost_per_kg: 30, sale_price_per_kg: 45, difficulty_pct: 100 },
      { id: 2, name: 'SUNLU ASA', material: 'ASA', cost_per_kg: 20, sale_price_per_kg: 30, difficulty_pct: 100 },
      { id: 3, name: 'eSUN ASA', material: 'ASA', cost_per_kg: 25, sale_price_per_kg: 38, difficulty_pct: 100 },
    ];
    expect(matchCalculatorFilament('ASA', asaProfiles)).toEqual({ filament: asaProfiles[1], matched: true });
  });

  it('picks the cheapest among name matches too', () => {
    const legacy: NamedCalculatorFilament[] = [
      { id: 1, name: 'PLA premium', cost_per_kg: 35, sale_price_per_kg: 50, difficulty_pct: 100 },
      { id: 2, name: 'PLA budget', cost_per_kg: 15, sale_price_per_kg: 25, difficulty_pct: 100 },
    ];
    expect(matchCalculatorFilament('PLA', legacy)).toEqual({ filament: legacy[1], matched: true });
  });

  it('falls back to the first filament when nothing matches', () => {
    expect(matchCalculatorFilament('ASA', filaments)).toEqual({ filament: filaments[0], matched: false });
  });

  it('falls back when the archive has no filament type', () => {
    expect(matchCalculatorFilament(null, filaments)).toEqual({ filament: filaments[0], matched: false });
    expect(matchCalculatorFilament('  ', filaments)).toEqual({ filament: filaments[0], matched: false });
  });

  it('returns null when there are no calculator filaments', () => {
    expect(matchCalculatorFilament('PLA', [])).toBeNull();
  });
});

describe('matchCalculatorPrinter', () => {
  it('matches a hint against the profile name, case-insensitively and by containment', () => {
    expect(matchCalculatorPrinter(['a1 mini'], twoPrinters)).toEqual({ printer: twoPrinters[1], matched: true });
    expect(matchCalculatorPrinter(['Bambu Lab H2S'], twoPrinters)).toEqual({ printer: twoPrinters[0], matched: true });
  });

  it('tries hints in order, skipping empty ones', () => {
    expect(matchCalculatorPrinter([null, '  ', 'A1 Mini', 'H2S'], twoPrinters)).toEqual({
      printer: twoPrinters[1],
      matched: true,
    });
  });

  it('falls back to the first printer when nothing matches', () => {
    expect(matchCalculatorPrinter(['X1 Carbon'], twoPrinters)).toEqual({ printer: twoPrinters[0], matched: false });
    expect(matchCalculatorPrinter([], twoPrinters)).toEqual({ printer: twoPrinters[0], matched: false });
  });

  it('returns null when there are no calculator printers', () => {
    expect(matchCalculatorPrinter(['H2S'], [])).toBeNull();
  });
});

describe('estimateArchiveSalePrice', () => {
  it('equals computePricing with zero labor for the matched filament', () => {
    const estimate = estimateArchiveSalePrice(archive, filaments, printers, defaults);
    expect(estimate).not.toBeNull();
    const reference = computePricing(
      {
        weight_g: 40,
        printing_time_h: 2,
        quantity: 1,
        modeling_hours: 0,
        modeling_base_price: 0,
        prep_model_min: 0,
        prep_slicing_min: 0,
        prep_transfer_min: 0,
        post_removal_min: 0,
        post_support_min: 0,
        post_additional_min: 0,
        post_fulfillment_min: 0,
        stuff_amount: 0,
        stuff_markup_pct: 0,
      },
      filaments[0],
      printers[0],
      defaults,
    );
    expect(estimate!.totalTtc).toBeCloseTo(reference.total_ttc, 6);
    expect(estimate!.machineCost).toBeCloseTo(reference.machine_cost, 6);
    expect(estimate!.energyCost).toBeCloseTo(reference.energy_cost, 6);
    expect(estimate!.filamentId).toBe(1);
    expect(estimate!.filamentName).toBe('PLA basique');
    expect(estimate!.filamentMatched).toBe(true);
    expect(estimate!.printerName).toBe('H2S');
    expect(estimate!.weightG).toBe(40);
    expect(estimate!.timeH).toBeCloseTo(2, 6);
  });

  it('archive estimate uses the curve at quantity 1 (whole job as one unit)', () => {
    // An archive estimate always prices the whole job as one unit (quantity
    // 1), so it must sit at the top of the quantity-discount curve — no
    // discount applied — while still picking up the size-margin curve.
    const zeroInputsForArchive = {
      modeling_hours: 0,
      modeling_base_price: 0,
      prep_model_min: 0,
      prep_slicing_min: 0,
      prep_transfer_min: 0,
      post_removal_min: 0,
      post_support_min: 0,
      post_additional_min: 0,
      post_fulfillment_min: 0,
      stuff_amount: 0,
      stuff_markup_pct: 0,
    };
    const est = estimateArchiveSalePrice(archive, filaments, printers, defaults)!; // reuse this file's fixtures
    const matchedFilament = matchCalculatorFilament(archive.filament_type, filaments)!.filament;
    const matchedPrinter = matchCalculatorPrinter([], printers)!.printer;
    const r = computePricing(
      { ...zeroInputsForArchive, weight_g: est.weightG, printing_time_h: est.timeH, quantity: 1 },
      matchedFilament, matchedPrinter, { ...defaults, base_fee_flat: 0 },
    );
    expect(est.totalTtc).toBeCloseTo(r.total_ttc, 6);
    expect(r.qty_factor).toBe(1);
  });

  it('uses measured energy instead of the watts × hours estimate when present', () => {
    const withEnergy = estimateArchiveSalePrice({ ...archive, energy_kwh: 0.5 }, filaments, printers, defaults)!;
    const estimated = estimateArchiveSalePrice(archive, filaments, printers, defaults)!;
    expect(withEnergy.energyCost).toBeCloseTo(0.5 * 120 * 1.5, 6); // = 90
    expect(withEnergy.totalTtc).toBeLessThan(estimated.totalTtc);
  });

  it('ignores measured energy of 0 or null', () => {
    const estimated = estimateArchiveSalePrice(archive, filaments, printers, defaults)!;
    for (const energy of [0, null]) {
      const e = estimateArchiveSalePrice({ ...archive, energy_kwh: energy }, filaments, printers, defaults)!;
      expect(e.energyCost).toBeCloseTo(estimated.energyCost, 6);
      expect(e.totalTtc).toBeCloseTo(estimated.totalTtc, 6);
    }
  });

  it('prefers actual time over the slicer estimate', () => {
    const estimate = estimateArchiveSalePrice(
      { ...archive, actual_time_seconds: 3600 },
      filaments,
      printers,
      defaults,
    );
    expect(estimate!.timeH).toBeCloseTo(1, 6);
  });

  it('reports the fallback filament with filamentMatched=false', () => {
    const estimate = estimateArchiveSalePrice({ ...archive, filament_type: 'ASA' }, filaments, printers, defaults);
    expect(estimate!.filamentMatched).toBe(false);
    expect(estimate!.filamentId).toBe(1);
  });

  it('uses the printer matching the archive via printer hints', () => {
    const estimate = estimateArchiveSalePrice(archive, filaments, twoPrinters, defaults, ['A1 Mini']);
    expect(estimate!.printerId).toBe(2);
    expect(estimate!.printerName).toBe('A1 Mini');
    expect(estimate!.printerMatched).toBe(true);
    // The cheaper, lower-wattage printer must actually flow into the pricing
    const onFirstPrinter = estimateArchiveSalePrice(archive, filaments, printers, defaults)!;
    expect(estimate!.totalTtc).toBeLessThan(onFirstPrinter.totalTtc);
  });

  it('falls back to the first printer with printerMatched=false when no hint matches', () => {
    const estimate = estimateArchiveSalePrice(archive, filaments, twoPrinters, defaults, ['X1 Carbon']);
    expect(estimate!.printerId).toBe(1);
    expect(estimate!.printerMatched).toBe(false);
  });

  it('returns null without weight, time, filaments, printers or defaults', () => {
    expect(estimateArchiveSalePrice({ ...archive, filament_used_grams: 0 }, filaments, printers, defaults)).toBeNull();
    expect(estimateArchiveSalePrice({ ...archive, filament_used_grams: null }, filaments, printers, defaults)).toBeNull();
    expect(
      estimateArchiveSalePrice({ ...archive, print_time_seconds: null, actual_time_seconds: null }, filaments, printers, defaults),
    ).toBeNull();
    expect(estimateArchiveSalePrice(archive, [], printers, defaults)).toBeNull();
    expect(estimateArchiveSalePrice(archive, filaments, [], defaults)).toBeNull();
    expect(estimateArchiveSalePrice(archive, filaments, printers, undefined)).toBeNull();
  });

  it('surfaces the unit cost, size margin and floor flag the price was built from', () => {
    const est = estimateArchiveSalePrice(archive, filaments, printers, defaults)!;
    const matchedFilament = matchCalculatorFilament(archive.filament_type, filaments)!.filament;
    const matchedPrinter = matchCalculatorPrinter([], printers)!.printer;
    const r = computePricing(
      {
        weight_g: est.weightG, printing_time_h: est.timeH, quantity: 1,
        modeling_hours: 0, modeling_base_price: 0, prep_model_min: 0, prep_slicing_min: 0, prep_transfer_min: 0,
        post_removal_min: 0, post_support_min: 0, post_additional_min: 0, post_fulfillment_min: 0,
        stuff_amount: 0, stuff_markup_pct: 0,
      },
      matchedFilament, matchedPrinter, { ...defaults, base_fee_flat: 0 },
    );
    expect(est.unitCost).toBeCloseTo(r.total_cost, 6);
    expect(est.sizeMargin).toBeCloseTo(r.size_margin, 6);
    expect(est.floorApplied).toBe(r.floor_applied);
    expect(est.sizeMargin).toBeGreaterThan(1);
  });

  it('reports floorApplied when min_task_price lifts a tiny print', () => {
    const tiny = { ...archive, filament_used_grams: 0.5, print_time_seconds: 60 };
    const est = estimateArchiveSalePrice(tiny, filaments, printers, { ...defaults, min_task_price: 1_000_000 })!;
    expect(est.floorApplied).toBe(true);
  });
});

describe('estimateFilamentCost', () => {
  it('computes grams × sale price × difficulty × filament markup', () => {
    const simple: NamedCalculatorFilament[] = [
      { id: 9, name: 'PLA', cost_per_kg: 15, sale_price_per_kg: 20, difficulty_pct: 150 },
    ];
    // 0.5 kg × 20 × 1.5 × 1.05 = 15.75
    expect(
      estimateFilamentCost({ filament_used_grams: 500, filament_type: 'PLA' }, simple, defaults),
    ).toBeCloseTo(15.75, 10);
  });

  it('matches the archive filament type against calculator profiles', () => {
    // PETG profile: 0.1 kg × 6300 × 1.75 × 1.05 = 1157.625
    expect(
      estimateFilamentCost({ filament_used_grams: 100, filament_type: 'PETG HF' }, filaments, defaults),
    ).toBeCloseTo(1157.625, 6);
    // Material-based match picks the PLA profile, not the first (PETG) one.
    expect(
      estimateFilamentCost({ filament_used_grams: 100, filament_type: 'PLA' }, filamentsWithMaterial, defaults),
    ).toBeCloseTo(0.1 * 5597 * 1.5 * 1.05, 6);
  });

  it('prices unmatched types with the fallback (first) filament profile', () => {
    expect(
      estimateFilamentCost({ filament_used_grams: 100, filament_type: 'TPU' }, filaments, defaults),
    ).toBeCloseTo(0.1 * 5597 * 1.5 * 1.05, 6);
  });

  it('returns null without weight, filaments or defaults', () => {
    expect(estimateFilamentCost({ filament_used_grams: 0, filament_type: 'PLA' }, filaments, defaults)).toBeNull();
    expect(estimateFilamentCost({ filament_used_grams: null, filament_type: 'PLA' }, filaments, defaults)).toBeNull();
    expect(estimateFilamentCost({ filament_used_grams: 100, filament_type: 'PLA' }, [], defaults)).toBeNull();
    expect(estimateFilamentCost({ filament_used_grams: 100, filament_type: 'PLA' }, filaments, undefined)).toBeNull();
  });
});

describe('matchCalculatorFilament with vendor', () => {
  const brandProfiles: NamedCalculatorFilament[] = [
    {
      id: 1,
      name: 'Bambu Lab PLA',
      brand: 'Bambu Lab',
      material: 'PLA',
      cost_per_kg: 20,
      sale_price_per_kg: 30,
      difficulty_pct: 100,
    },
    {
      id: 2,
      name: 'SUNLU PLA',
      brand: 'SUNLU',
      material: 'PLA',
      cost_per_kg: 25,
      sale_price_per_kg: 38,
      difficulty_pct: 100,
    },
    {
      id: 3,
      name: 'SUNLU PETG',
      brand: 'SUNLU',
      material: 'PETG',
      cost_per_kg: 22,
      sale_price_per_kg: 33,
      difficulty_pct: 100,
    },
  ];

  it('prefers the brand-matching profile over a cheaper same-material one', () => {
    expect(matchCalculatorFilament('PLA', brandProfiles, 'SUNLU')).toEqual({
      filament: brandProfiles[1],
      matched: true,
    });
  });

  it('requires the material to match too — vendor alone is not enough', () => {
    // SUNLU vendor + PETG type must pick SUNLU PETG, not SUNLU PLA.
    expect(matchCalculatorFilament('PETG', brandProfiles, 'SUNLU')).toEqual({
      filament: brandProfiles[2],
      matched: true,
    });
  });

  it('matches a preset-name style vendor hint by containment', () => {
    expect(matchCalculatorFilament('PLA', brandProfiles, 'SUNLU PLA Matte - Black')).toEqual({
      filament: brandProfiles[1],
      matched: true,
    });
  });

  it('treats Generic as no vendor and falls back to the cheapest material match', () => {
    expect(matchCalculatorFilament('PLA', brandProfiles, 'Generic')).toEqual({
      filament: brandProfiles[0],
      matched: true,
    });
  });

  it('falls back to the cheapest material match when no brand matches', () => {
    expect(matchCalculatorFilament('PLA', brandProfiles, 'Polymaker')).toEqual({
      filament: brandProfiles[0],
      matched: true,
    });
  });

  it('keeps the old behavior when no vendor is given', () => {
    expect(matchCalculatorFilament('PLA', brandProfiles)).toEqual({
      filament: brandProfiles[0],
      matched: true,
    });
  });

  it('tries comma-separated vendors in order', () => {
    expect(matchCalculatorFilament('PLA', brandProfiles, 'Generic, SUNLU')).toEqual({
      filament: brandProfiles[1],
      matched: true,
    });
  });

  it('flows through estimateArchiveSalePrice from the archive filament_vendor', () => {
    const est = estimateArchiveSalePrice(
      { ...archive, filament_vendor: 'SUNLU' },
      brandProfiles,
      printers,
      defaults,
      ['H2S'],
    );
    expect(est?.filamentId).toBe(2);
    expect(est?.filamentMatched).toBe(true);
  });

  it('flows through estimateFilamentCost from the archive filament_vendor', () => {
    const withVendor = estimateFilamentCost(
      { filament_used_grams: 40, filament_type: 'PLA', filament_vendor: 'SUNLU' },
      brandProfiles,
      defaults,
    );
    const withoutVendor = estimateFilamentCost(
      { filament_used_grams: 40, filament_type: 'PLA', filament_vendor: null },
      brandProfiles,
      defaults,
    );
    // SUNLU PLA is more expensive than the cheapest PLA, so the two differ.
    expect(withVendor).not.toBeNull();
    expect(withoutVendor).not.toBeNull();
    expect(withVendor!).toBeGreaterThan(withoutVendor!);
  });
});

describe('matchCalculatorFilament vendor edge cases', () => {
  const profiles: NamedCalculatorFilament[] = [
    {
      id: 1,
      name: 'Bambu Lab PLA',
      brand: 'Bambu Lab',
      material: 'PLA',
      cost_per_kg: 20,
      sale_price_per_kg: 30,
      difficulty_pct: 100,
    },
    {
      id: 2,
      name: 'SUNLU PLA',
      brand: 'SUNLU',
      material: 'PLA',
      cost_per_kg: 25,
      sale_price_per_kg: 38,
      difficulty_pct: 100,
    },
    {
      id: 3,
      name: 'Polymaker PETG',
      brand: 'Polymaker',
      material: 'PETG',
      cost_per_kg: 18,
      sale_price_per_kg: 27,
      difficulty_pct: 100,
    },
  ];

  it('ignores a brand that only exists with a different material', () => {
    // Polymaker exists in the DB, but only as PETG — a Polymaker PLA print
    // must fall back to the cheapest PLA, never cross materials.
    expect(matchCalculatorFilament('PLA', profiles, 'Polymaker')).toEqual({
      filament: profiles[0],
      matched: true,
    });
  });

  it('matches brands case-insensitively', () => {
    expect(matchCalculatorFilament('PLA', profiles, 'sunlu')).toEqual({
      filament: profiles[1],
      matched: true,
    });
  });

  it('matches when the hint is a substring of the brand', () => {
    expect(matchCalculatorFilament('PLA', profiles, 'Bambu')).toEqual({
      filament: profiles[0],
      matched: true,
    });
  });

  it('picks the cheapest among several same-brand matches', () => {
    const dupes: NamedCalculatorFilament[] = [
      { id: 1, name: 'SUNLU PLA+', brand: 'SUNLU', material: 'PLA', cost_per_kg: 30, sale_price_per_kg: 45, difficulty_pct: 100 },
      { id: 2, name: 'SUNLU PLA Eco', brand: 'SUNLU', material: 'PLA', cost_per_kg: 22, sale_price_per_kg: 33, difficulty_pct: 100 },
    ];
    expect(matchCalculatorFilament('PLA', dupes, 'SUNLU')).toEqual({ filament: dupes[1], matched: true });
  });

  it('treats whitespace / comma-only vendor strings as no vendor', () => {
    expect(matchCalculatorFilament('PLA', profiles, '  , ,  ')).toEqual({
      filament: profiles[0],
      matched: true,
    });
    expect(matchCalculatorFilament('PLA', profiles, '')).toEqual({
      filament: profiles[0],
      matched: true,
    });
    expect(matchCalculatorFilament('PLA', profiles, null)).toEqual({
      filament: profiles[0],
      matched: true,
    });
  });

  it('skips generic-prefixed preset names, not just the bare word', () => {
    // A blank vendor backfilled from filament_settings_id can read
    // "Generic PLA" — still no real brand.
    expect(matchCalculatorFilament('PLA', profiles, 'Generic PLA')).toEqual({
      filament: profiles[0],
      matched: true,
    });
  });

  it('skips profiles with empty brand strings in the brand tier', () => {
    const brandless: NamedCalculatorFilament[] = [
      { id: 1, name: 'Mystery PLA', brand: '', material: 'PLA', cost_per_kg: 1, sale_price_per_kg: 2, difficulty_pct: 100 },
      { id: 2, name: 'SUNLU PLA', brand: 'SUNLU', material: 'PLA', cost_per_kg: 25, sale_price_per_kg: 38, difficulty_pct: 100 },
    ];
    // '' would containment-match anything; the empty brand must not win the
    // brand tier just because it is cheaper.
    expect(matchCalculatorFilament('PLA', brandless, 'SUNLU')).toEqual({
      filament: brandless[1],
      matched: true,
    });
  });

  it('still returns the unmatched fallback when the type is missing, vendor or not', () => {
    expect(matchCalculatorFilament(null, profiles, 'SUNLU')).toEqual({
      filament: profiles[0],
      matched: false,
    });
  });

  it('returns null on an empty filament list regardless of vendor', () => {
    expect(matchCalculatorFilament('PLA', [], 'SUNLU')).toBeNull();
  });

  it('multi-material archive: first vendor with a brand match wins', () => {
    // "PLA, PETG" + "SUNLU, Polymaker": SUNLU PLA matches on the first hint.
    expect(matchCalculatorFilament('PLA, PETG', profiles, 'SUNLU, Polymaker')).toEqual({
      filament: profiles[1],
      matched: true,
    });
  });

  it('calculatorPrefillUrl carries the vendor-matched filament id', () => {
    const url = calculatorPrefillUrl(
      {
        filament_used_grams: 40,
        print_time_seconds: 7200,
        actual_time_seconds: null,
        filament_type: 'PLA',
        filament_vendor: 'SUNLU',
      },
      { filaments: profiles, printers, defaults },
      ['H2S'],
    );
    expect(url).toContain('filamentId=2');
  });

  it('calculatorPrefillUrl without vendor keeps the cheapest-material pick', () => {
    const url = calculatorPrefillUrl(
      {
        filament_used_grams: 40,
        print_time_seconds: 7200,
        actual_time_seconds: null,
        filament_type: 'PLA',
      },
      { filaments: profiles, printers, defaults },
      ['H2S'],
    );
    expect(url).toContain('filamentId=1');
  });
});

describe('medianUnitCost', () => {
  const calcConfig = { filaments, printers, defaults };
  const names = new Map<number, string>([[7, 'H2S']]);
  const row = (grams: number, status = 'completed', completed_at = '2026-08-01T00:00:00Z') => ({
    filament_used_grams: grams, print_time_seconds: 3600, actual_time_seconds: null,
    filament_type: 'PLA', status, printer_id: 7, completed_at,
  });

  it('returns null below five usable completed prints', () => {
    expect(medianUnitCost([row(10), row(20), row(30), row(40)], calcConfig, names)).toBeNull();
    expect(medianUnitCost([row(10), row(20), row(30), row(40), row(50, 'failed')], calcConfig, names)).toBeNull();
  });

  it('takes the median unit cost over completed prints (odd and even counts)', () => {
    const odd = [10, 20, 30, 40, 50].map((g) => row(g));
    const mid = estimateArchiveSalePrice(row(30), filaments, printers, defaults, ['H2S'])!.unitCost;
    expect(medianUnitCost(odd, calcConfig, names)).toEqual({ median: mid, count: 5 });
    const even = [10, 20, 30, 40, 50, 60].map((g) => row(g));
    const a = estimateArchiveSalePrice(row(30), filaments, printers, defaults, ['H2S'])!.unitCost;
    const b = estimateArchiveSalePrice(row(40), filaments, printers, defaults, ['H2S'])!.unitCost;
    expect(medianUnitCost(even, calcConfig, names)!.median).toBeCloseTo((a + b) / 2, 6);
  });

  it('keeps only the most recent MEDIAN_MAX_SAMPLES rows and skips rows without weight or time', () => {
    const many = Array.from({ length: 120 }, (_, i) => row(10 + i, 'completed', `2026-0${1 + Math.floor(i / 30)}-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00Z`));
    expect(medianUnitCost(many, calcConfig, names)!.count).toBe(MEDIAN_MAX_SAMPLES);
    expect(medianUnitCost([row(0), row(0), row(0), row(0), row(0), row(0)], calcConfig, names)).toBeNull();
  });
});
