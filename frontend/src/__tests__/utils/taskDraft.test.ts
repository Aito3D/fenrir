import { describe, it, expect } from 'vitest';
import {
  emptyTaskDraft,
  splitMinutes,
  joinMinutes,
  computeImpressionCost,
  hasPricedService,
  projectHasPricedService,
  taskTotal,
  projectTotal,
  taskDraftFromAitoTask,
  taskDraftToTaskCreate,
  roundUpTo50,
} from '../../utils/taskDraft';
import type { PricingDefaults, PricingFilament, PricingPrinter } from '../../utils/pricing';
import type { AitoTask } from '../../api/client';

const filament: PricingFilament = { cost_per_kg: 3000, sale_price_per_kg: 6000, difficulty_pct: 100 };
const printer: PricingPrinter = {
  purchase_price: 300000,
  lifetime_years: 5,
  daily_usage_hours: 8,
  power_watts: 150,
  repair_rate_pct: 5,
};
const defaults: PricingDefaults = {
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

const impression = {
  printerId: 1,
  filamentId: 1,
  weightG: 120,
  timeMin: 270,
  quantity: 1,
  color: 'Noir',
};

describe('splitMinutes / joinMinutes', () => {
  it.each([
    [0, { days: 0, hours: 0, minutes: 0 }],
    [90, { days: 0, hours: 1, minutes: 30 }],
    [270, { days: 0, hours: 4, minutes: 30 }],
    [1500, { days: 1, hours: 1, minutes: 0 }],
  ])('splits %i minutes', (total, expected) => {
    expect(splitMinutes(total)).toEqual(expected);
  });

  it('round-trips', () => {
    for (const total of [0, 1, 59, 60, 90, 270, 1439, 1440, 1500]) {
      expect(joinMinutes(splitMinutes(total))).toBe(total);
    }
  });
});

describe('computeImpressionCost', () => {
  it.each([
    ['printer', { printerId: null }],
    ['filament', { filamentId: null }],
    ['weight', { weightG: null }],
    ['time', { timeMin: null }],
  ])('returns null when %s is missing', (_label, patch) => {
    expect(
      computeImpressionCost({ ...impression, ...patch }, filament, printer, defaults),
    ).toBeNull();
  });

  it('returns null when the filament or printer record is unavailable', () => {
    expect(computeImpressionCost(impression, null, printer, defaults)).toBeNull();
    expect(computeImpressionCost(impression, filament, null, defaults)).toBeNull();
  });

  it('zeroes the per-job flats so a project is not charged them per print', () => {
    // The engine treats base_fee_flat and consumables_packaging_flat as
    // one-time per JOB. A project is the job, so a task must not carry them —
    // three print tasks would otherwise be charged them three times.
    const withFlats = computeImpressionCost(impression, filament, printer, defaults);
    const withoutFlats = computeImpressionCost(impression, filament, printer, {
      ...defaults,
      base_fee_flat: 0,
      consumables_packaging_flat: 0,
    });
    expect(withFlats!.total_ttc_qty).toBeCloseTo(withoutFlats!.total_ttc_qty, 6);
    expect(withFlats!.base_fee_total).toBe(0);
    expect(withFlats!.consumables_flat).toBe(0);
  });

  it('excludes labour, which the sibling services carry', () => {
    const r = computeImpressionCost(impression, filament, printer, defaults)!;
    expect(r.modeling_cost_total).toBe(0);
    expect(r.prep_cost_total).toBe(0);
    expect(r.post_processing_cost).toBe(0);
    expect(r.stuff_cost).toBe(0);
  });

  it('multiplies the line total by quantity', () => {
    const one = computeImpressionCost(impression, filament, printer, defaults)!;
    const two = computeImpressionCost({ ...impression, quantity: 2 }, filament, printer, defaults)!;
    expect(two.total_ttc_qty).toBeCloseTo(one.total_ttc_qty * 2, 6);
  });

  it('treats a missing or zero quantity as 1', () => {
    const one = computeImpressionCost(impression, filament, printer, defaults)!;
    const zero = computeImpressionCost({ ...impression, quantity: 0 }, filament, printer, defaults)!;
    expect(zero.total_ttc_qty).toBeCloseTo(one.total_ttc_qty, 6);
  });
});

describe('taskTotal / projectTotal', () => {
  const base = emptyTaskDraft();

  it('sums only enabled services', () => {
    expect(taskTotal({ ...base, scanCost: 4000, usinageCost: 12000 })).toBe(16000);
  });

  it('treats null as disabled and 0 as free', () => {
    expect(taskTotal(base)).toBe(0);
    expect(taskTotal({ ...base, scanCost: 0 })).toBe(0);
    expect(taskTotal({ ...base, scanCost: null, modelisationCost: 500 })).toBe(500);
  });

  it('includes the frozen impression cost', () => {
    expect(taskTotal({ ...base, scanCost: 1000, impressionCost: 4200 })).toBe(5200);
  });

  it('sums tasks', () => {
    expect(projectTotal([{ ...base, scanCost: 1000 }, { ...base, usinageCost: 2000 }])).toBe(3000);
  });
});

describe('taskDraftFromAitoTask / taskDraftToTaskCreate', () => {
  // Both directions used to be written out twice — once in AitoPage.tsx (the
  // create modal's inline mapping) and once in ProjectDetailPanel.tsx — and
  // agreed only because one was copy-pasted from the other. Now both callers
  // share this pair, so this round trip is the single place the wire contract
  // is pinned.
  const row: AitoTask = {
    id: 7,
    project_id: 3,
    position: 0,
    title: 'Bracket',
    description: 'Custom bracket',
    scan_description: 'Scanner la pièce',
    modelisation_description: null,
    impression_description: 'PETG noir',
    usinage_description: null,
    scan_cost: 0,
    modelisation_cost: null,
    usinage_cost: 1500,
    impression_printer_id: 1,
    impression_filament_id: 2,
    impression_weight_g: 120,
    impression_time_min: 270,
    impression_quantity: 3,
    impression_color: 'Noir',
    impression_cost: 4200,
    impression_discount_pct: 15,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };

  it('reproduces a persisted row\'s wire fields after a round trip through the draft shape', () => {
    const wireBack = taskDraftToTaskCreate(taskDraftFromAitoTask(row));
    expect(wireBack).toEqual({
      title: row.title,
      description: row.description,
      scan_description: row.scan_description,
      modelisation_description: row.modelisation_description,
      impression_description: row.impression_description,
      usinage_description: row.usinage_description,
      scan_cost: row.scan_cost,
      modelisation_cost: row.modelisation_cost,
      usinage_cost: row.usinage_cost,
      impression_printer_id: row.impression_printer_id,
      impression_filament_id: row.impression_filament_id,
      impression_weight_g: row.impression_weight_g,
      impression_time_min: row.impression_time_min,
      impression_quantity: row.impression_quantity,
      impression_color: row.impression_color,
      impression_cost: row.impression_cost,
      impression_discount_pct: row.impression_discount_pct,
    });
  });

  it('a 0 cost survives the round trip as 0, and a null cost survives as null', () => {
    // 0 (free) and null (disabled) must never collapse into each other —
    // `t.scanCost || null` would type-check here and silently turn a free
    // service into a disabled one.
    expect(taskDraftFromAitoTask(row).scanCost).toBe(0);
    expect(taskDraftToTaskCreate(taskDraftFromAitoTask(row)).scan_cost).toBe(0);

    expect(taskDraftFromAitoTask(row).modelisationCost).toBeNull();
    expect(taskDraftToTaskCreate(taskDraftFromAitoTask(row)).modelisation_cost).toBeNull();
  });

  it('round-trips per-service descriptions between wire and draft shape', () => {
    const draft = emptyTaskDraft();
    draft.scanDescription = 'Scanner la pièce';
    draft.impressionDescription = 'PETG noir';
    const wire = taskDraftToTaskCreate(draft);
    expect(wire.scan_description).toBe('Scanner la pièce');
    expect(wire.impression_description).toBe('PETG noir');
    // Blank collapses to null, never '' — same rule as title.
    expect(wire.modelisation_description).toBeNull();
    expect(wire.usinage_description).toBeNull();
  });

  it('reads per-service descriptions from a persisted task, defaulting to empty strings', () => {
    const draft = taskDraftFromAitoTask({
      ...row,
      scan_description: 'note',
      modelisation_description: null,
      impression_description: null,
      usinage_description: null,
    });
    expect(draft.scanDescription).toBe('note');
    expect(draft.modelisationDescription).toBe('');
  });
});

// Rehomed from NewProjectModal.test.tsx (task 13): these predicates gate
// submit on both the modal's replacement (NewProjectDrawer) and the create
// mutation's mapping — they were never modal-specific, and lived there only
// because that was the first caller to need them.
describe('taskDraft service predicates', () => {
  it('treats a zero cost as priced and null as disabled', () => {
    expect(hasPricedService(emptyTaskDraft())).toBe(false);
    expect(hasPricedService({ ...emptyTaskDraft(), scanCost: 0 })).toBe(true);
    expect(hasPricedService({ ...emptyTaskDraft(), impressionCost: 2400 })).toBe(true);
  });

  it('requires every task to be priced, not just one', () => {
    const priced = { ...emptyTaskDraft(), scanCost: 10 };
    expect(projectHasPricedService([priced, emptyTaskDraft()])).toBe(false);
    expect(projectHasPricedService([priced])).toBe(true);
    expect(projectHasPricedService([])).toBe(false);
  });
});

describe('taskTotal with an impression discount', () => {
  it('applies the discount to the impression cost only', () => {
    const task = { ...emptyTaskDraft(), scanCost: 500, impressionCost: 1000, impressionDiscountPct: 10 };
    expect(taskTotal(task)).toBeCloseTo(1400, 6);
  });

  it('no discount leaves the total untouched', () => {
    const task = { ...emptyTaskDraft(), impressionCost: 1000 };
    expect(taskTotal(task)).toBe(1000);
  });
});

describe('roundUpTo50', () => {
  it('rounds up to the next multiple of 50', () => {
    expect(roundUpTo50(123)).toBe(150);
    expect(roundUpTo50(201)).toBe(250);
    expect(roundUpTo50(390)).toBe(400);
    expect(roundUpTo50(1)).toBe(50);
  });

  it('leaves exact multiples alone and shrugs off float noise', () => {
    expect(roundUpTo50(150)).toBe(150);
    expect(roundUpTo50(150.0000000001)).toBe(150);
    expect(roundUpTo50(0)).toBe(0);
  });
});
