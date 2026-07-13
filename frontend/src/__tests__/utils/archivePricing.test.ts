import { describe, it, expect } from 'vitest';
import {
  estimateArchiveSalePrice,
  matchCalculatorFilament,
  matchCalculatorPrinter,
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
});
