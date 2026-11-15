import { describe, it, expect } from 'vitest';
import {
  objectLines,
  mainFilament,
  matchPrinter,
  matchFilament,
  plateTitle,
  isImportable,
  plateToDraft,
} from '../../utils/aito3mfImport';
import type { Aito3mfPlate } from '../../api/client';
import type { PricingDefaults } from '../../utils/pricing';
import { computeImpressionCost, roundUpTo50 } from '../../utils/taskDraft';

const printerCosts = { purchase_price: 300000, lifetime_years: 5, daily_usage_hours: 8, power_watts: 150, repair_rate_pct: 5 };
const filamentCosts = { cost_per_kg: 3000, sale_price_per_kg: 6000, difficulty_pct: 100 };
const X1C = { id: 1, name: 'Bambu X1C', ...printerCosts };
const A1 = { id: 2, name: 'A1 mini', ...printerCosts };
const PETG_SUNLU = { id: 10, brand: 'SUNLU', material: 'PETG', ...filamentCosts };
const PETG_POLY = { id: 11, brand: 'Polymaker', material: 'PETG', ...filamentCosts };
const PLA = { id: 12, brand: 'Bambu Lab', material: 'PLA', ...filamentCosts };
const DEFAULTS: PricingDefaults = {
  electricity_tariff: 30,
  labor_rate_per_hour: 3000,
  consumables_packaging_flat: 500,
  failure_rate_pct: 5,
  prototype_rate_pct: 5,
  ads_rate_pct: 3,
  filament_markup_pct: 50,
  global_markup_pct: 30,
  tax_pct: 0,
  default_difficulty_pct: 100,
  stuff_markup_pct: 20,
  base_fee_flat: 2000,
};
const petg = (vendor: string | null, used_g = 70) => ({ type: 'PETG', color: '#000000', used_g, vendor });
const PLATE: Aito3mfPlate = {
  index: 1,
  name: 'Marteaux',
  print_time_seconds: 21955,
  weight_g: 76.62,
  printer_model: 'X1C',
  filaments: [petg('SUNLU'), { type: 'PLA', color: '#FFFFFF', used_g: 6.62, vendor: 'Bambu Lab' }],
  objects: [{ name: 'marteau', count: 2, x_mm: 120, y_mm: 30, z_mm: 50 }],
  thumbnail: null,
};

describe('objectLines', () => {
  it('formats object lines', () => {
    expect(
      objectLines([
        { name: 'marteau', count: 2, x_mm: 120, y_mm: 30, z_mm: 50 },
        { name: 'embout', count: 4, x_mm: null, y_mm: null, z_mm: null },
      ]),
    ).toBe('2 x marteau [120x30x50mm]\n4 x embout');
  });
});

describe('mainFilament', () => {
  it('picks the heaviest filament as main', () => {
    expect(mainFilament({ ...PLATE, filaments: [petg('a', 3), petg('b', 9), petg('c', 5)] })?.vendor).toBe('b');
    expect(mainFilament({ ...PLATE, filaments: [] })).toBeNull();
  });
});

describe('matchPrinter', () => {
  it('matches the printer by contained model name, case-insensitive', () => {
    expect(matchPrinter('x1c', [X1C, A1])).toBe(1);
  });
  it('does not match when two printers contain the model', () => {
    expect(matchPrinter('X1C', [X1C, { ...X1C, id: 3, name: 'X1C atelier' }])).toBeNull();
  });
  it('does not match an unknown or missing model', () => {
    expect(matchPrinter('H2D', [X1C, A1])).toBeNull();
    expect(matchPrinter(null, [X1C])).toBeNull();
  });
});

describe('matchFilament', () => {
  it('matches a single filament of the material', () => {
    expect(matchFilament({ type: 'pla', color: '', used_g: 1, vendor: null }, [PETG_SUNLU, PLA]).id).toBe(12);
  });
  it('breaks a material tie by vendor', () => {
    expect(matchFilament(petg('sunlu'), [PETG_SUNLU, PETG_POLY, PLA]).id).toBe(10);
  });
  it('asks among the material matches when the vendor does not settle it', () => {
    const r = matchFilament(petg('Generic'), [PETG_SUNLU, PETG_POLY, PLA]);
    expect(r.id).toBeNull();
    expect(r.candidates.map((f) => f.id)).toEqual([10, 11]);
  });
  it('offers every filament when no material matches', () => {
    const r = matchFilament({ type: 'ASA', color: '', used_g: 1, vendor: null }, [PETG_SUNLU, PLA]);
    expect(r.id).toBeNull();
    expect(r.candidates).toHaveLength(2);
    expect(matchFilament(null, [PLA]).candidates).toHaveLength(1);
  });
});

describe('plateTitle', () => {
  const fallback = (n: number) => `Plaque ${n}`;
  it('names an unnamed plate of a multi-plate file by number, of a single-plate file by filename', () => {
    expect(plateTitle(PLATE, 3, 'Outils.3mf', fallback)).toBe('Marteaux');
    expect(plateTitle({ ...PLATE, name: null, index: 2 }, 3, 'Outils.3mf', fallback)).toBe('Plaque 2');
    expect(plateTitle({ ...PLATE, name: null }, 1, 'Outils client.3MF', fallback)).toBe('Outils client');
  });
  it('cuts a 300-character plate name to 200 and keeps a 40-line note whole', () => {
    expect(plateTitle({ ...PLATE, name: 'a'.repeat(300) }, 1, 'x.3mf', fallback)).toHaveLength(200);
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `p${i}`, count: 1, x_mm: 1, y_mm: 1, z_mm: 1 }));
    expect(objectLines(many).split('\n')).toHaveLength(40);
  });
});

describe('isImportable', () => {
  it('treats an empty or weightless plate as not importable', () => {
    expect(isImportable(PLATE)).toBe(true);
    expect(isImportable({ ...PLATE, objects: [] })).toBe(false);
    expect(isImportable({ ...PLATE, weight_g: 0 })).toBe(false);
    expect(isImportable({ ...PLATE, print_time_seconds: null, weight_g: null })).toBe(false);
  });
});

describe('plateToDraft', () => {
  it('builds a priced print-only draft', () => {
    const d = plateToDraft(PLATE, 'Marteaux', X1C, PETG_SUNLU, DEFAULTS);
    expect(d.title).toBe('Marteaux');
    expect(d.impression).toEqual({ printerId: 1, filamentId: 10, weightG: 76.62, timeMin: 366, quantity: 1, color: '' });
    expect(d.impressionDescription).toBe('2 x marteau [120x30x50mm]');
    const priced = computeImpressionCost(d.impression, PETG_SUNLU, X1C, DEFAULTS);
    expect(d.impressionCost).toBe(roundUpTo50(priced!.total_ttc));
    expect([d.scanCost, d.modelisationCost, d.usinageCost, d.maindoeuvreCost]).toEqual([null, null, null, null]);
  });
});
